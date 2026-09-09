package com.dsh.flowable.delegate;

import com.dsh.flowable.config.DshHeadlessProperties;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * DSH headless profile 调用组件:定制 delegate 需要智能服务(LLM)时注入本组件,
 * 不与任何 BPMN 扩展属性耦合。
 *
 * <p>调用模型:一次性任务子进程({@code node --import tsx/esm <cliEntry>
 * --profile headless "<task>"},工作目录为 DSH 仓库根)。headless 把最终 assistant
 * 文本打到 stdout 后退出,退出码 0 表示正常完成;本组件把文本解析为 JSON 对象返回,
 * 由调用方 delegate 决定写回哪些 execution 变量(setVariable 写语义化结果变量)。
 *
 * <p>任务文本 = 指令 + 流程变量 JSON + "最终回复只输出一个 JSON 对象"的输出要求;
 * 指令里需写明输出 JSON 的字段约定。
 *
 * <p>失败语义:repo-root 未配置、子进程非 0 退出、超时或输出不含合法 JSON 时抛
 * IllegalStateException。调用方挂在高配 {@code flowable:async="true"} 的 ServiceTask
 * 上时,异常使 Job 进入 {@code ACT_RU_JOB} 异常重试队列,按
 * {@code flowable:failedJobRetryTimeCycle} 重试;全部失败后 Job 进死信,流程实例
 * 停留于该节点等待人工干预。超时秒数由 {@link DshHeadlessProperties#callTimeoutSeconds()}
 * 控制,超时即强制结束子进程。
 *
 * <p>repo-root 校验放在调用期而非启动期:没有自动节点的部署不应因缺配置启动失败,
 * 缺失时在 {@link #execute} 抛异常(fail loud 到最早可解析点)。
 *
 * <p>前置条件(引擎进程环境):{@code DEEPSEEK_API_KEY} 已设置(headless 的 LLM 调用读它)、
 * {@code node} 在 PATH 上、{@code dsh.headless.repo-root}(DSH_REPO_ROOT)指向仓库根目录。
 * headless 任务是纯 LLM 判断,不要求模型执行工具或脚本。
 */
@Component
public class DshHeadlessClient {

    /** 单条错误信息里携带的 stderr/输出文本上限,避免日志被长输出淹没。 */
    private static final int ERROR_TEXT_LIMIT = 500;

    private static final Logger log = LoggerFactory.getLogger(DshHeadlessClient.class);

    private final DshHeadlessProperties properties;
    private final ObjectMapper objectMapper;

    public DshHeadlessClient(DshHeadlessProperties properties, ObjectMapper objectMapper) {
        this.properties = properties;
        this.objectMapper = objectMapper;
    }

    /**
     * 执行一次 headless LLM 调用并返回结构化输出。
     *
     * @param instruction 任务指令,含输出 JSON 的字段约定
     * @param variables   随指令下发的流程变量,整体序列化为 JSON 附在指令后
     * @param activityId  调用方节点 id,用于异常信息与日志定位
     * @return 模型输出的 JSON 对象(Map)
     */
    public Map<String, Object> execute(String instruction, Map<String, Object> variables, String activityId) {
        if (properties.repoRoot().isBlank()) {
            throw new IllegalStateException("dsh.headless.repo-root 未配置(环境变量 DSH_REPO_ROOT):"
                + "调用 DSH headless 需要 DSH 仓库根目录来启动子进程(activity " + activityId + ")");
        }
        String task = buildTask(instruction, variables);
        String assistantText = runHeadless(task, activityId);
        Map<String, Object> output = parseOutput(assistantText, activityId);
        log.info("[DSH headless] {} 完成: {}", activityId, abbreviate(assistantText));
        return output;
    }

    /**
     * 组装一次性任务文本:指令 + 流程变量 + 严格 JSON 输出要求。
     */
    private String buildTask(String instruction, Map<String, Object> variables) {
        String variablesJson;
        try {
            variablesJson = objectMapper.writeValueAsString(variables);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("流程变量序列化为 JSON 失败,无法构造 headless 任务", e);
        }
        return instruction
            + "\n\n## 当前流程变量(JSON)\n" + variablesJson
            + "\n\n## 输出要求\n按任务说明约定的字段,最终回复只输出一个 JSON 对象本身:"
            + "不要 markdown 代码块,不要任何解释文字或前后缀。";
    }

    /**
     * 启动 headless 一次性任务进程并同步等待:stdout 全文即最终 assistant 文本,
     * 退出码 0 表示任务正常完成。
     */
    private String runHeadless(String task, String activityId) {
        List<String> command = List.of(
            properties.nodeBin(),
            "--import", "tsx/esm",
            properties.cliEntry(),
            "--profile", "headless",
            task
        );
        Process process;
        try {
            process = new ProcessBuilder(command)
                .directory(new File(properties.repoRoot()))
                .start();
        } catch (IOException e) {
            throw new IllegalStateException("启动 DSH headless 进程失败(activity " + activityId
                + ", cwd=" + properties.repoRoot() + "): " + command, e);
        }

        StringBuilder stdout = new StringBuilder();
        StringBuilder stderr = new StringBuilder();
        Thread stdoutReader = drain(process.getInputStream(), stdout);
        Thread stderrReader = drain(process.getErrorStream(), stderr);

        boolean finished;
        try {
            finished = process.waitFor(properties.callTimeoutSeconds(), TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            process.destroyForcibly();
            throw new IllegalStateException("DSH headless 调用被中断(activity " + activityId + ")", e);
        }
        if (!finished) {
            process.destroyForcibly();
            throw new IllegalStateException("DSH headless 调用超时(>"
                + properties.callTimeoutSeconds() + "s, activity " + activityId + "),进程已强制结束");
        }
        awaitReader(stdoutReader);
        awaitReader(stderrReader);

        int exitCode = process.exitValue();
        if (exitCode != 0) {
            throw new IllegalStateException("DSH headless 进程退出码 " + exitCode
                + "(activity " + activityId + "): " + tail(stderr));
        }
        String text = stdout.toString().trim();
        if (text.isEmpty()) {
            throw new IllegalStateException("DSH headless 无输出(activity " + activityId
                + "): " + tail(stderr));
        }
        return text;
    }

    /**
     * 后台线程持续读干子进程输出流,防止管道缓冲区写满导致子进程卡死;结果追加到 target。
     */
    private Thread drain(InputStream stream, StringBuilder target) {
        Thread reader = new Thread(() -> {
            try (BufferedReader bufferedReader = new BufferedReader(
                new InputStreamReader(stream, StandardCharsets.UTF_8))) {
                char[] chunk = new char[4096];
                int read;
                while ((read = bufferedReader.read(chunk)) != -1) {
                    target.append(chunk, 0, read);
                }
            } catch (IOException ignored) {
                // 子进程被强制结束时管道关闭、read 抛错:超时/异常路径不消费读取结果,忽略即可
            }
        });
        reader.setDaemon(true);
        reader.start();
        return reader;
    }

    private void awaitReader(Thread reader) {
        try {
            reader.join(TimeUnit.SECONDS.toMillis(10));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /**
     * 从最终 assistant 文本提取 JSON 对象:容忍模型把 JSON 包在代码块或说明文字里,
     * 取首个左花括号与末个右花括号之间内容解析;解析失败视为执行失败(触发重试)。
     */
    private Map<String, Object> parseOutput(String text, String activityId) {
        int start = text.indexOf('{');
        int end = text.lastIndexOf('}');
        if (start < 0 || end <= start) {
            throw new IllegalStateException("DSH headless 输出不含 JSON 对象(activity "
                + activityId + "): " + abbreviate(text));
        }
        try {
            return objectMapper.readValue(
                text.substring(start, end + 1),
                new TypeReference<Map<String, Object>>() {});
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("DSH headless 输出 JSON 解析失败(activity "
                + activityId + "): " + abbreviate(text), e);
        }
    }

    private String tail(StringBuilder text) {
        return abbreviate(text.toString());
    }

    private String abbreviate(String text) {
        String trimmed = text.trim();
        return trimmed.length() <= ERROR_TEXT_LIMIT
            ? trimmed
            : trimmed.substring(0, ERROR_TEXT_LIMIT) + "...(截断)";
    }
}
