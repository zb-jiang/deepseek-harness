package com.dsh.flowable.delegate;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;

import org.flowable.bpmn.model.FlowElement;
import org.flowable.engine.delegate.DelegateExecution;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * 流程实例业务日志:每个流程实例一个独立文件 {@code logs/process/<流程实例id>.log},
 * 与引擎后台日志完全分离;按实例 id 直接打开对应文件即可看到该实例的完整轨迹。
 *
 * <p>每行格式:{@code 时间 [节点名(节点id)] 消息}(实例 id 已体现在文件名,行内不重复)。
 * 追加模式写入,重试重放与并行分支的日志都落同一个文件;写失败只记引擎日志告警,
 * 不中断流程执行。
 */
public final class ProcessLog {

    private static final Logger LOG = LoggerFactory.getLogger(ProcessLog.class);

    private static final Path LOG_DIR = Path.of("logs", "process");
    private static final DateTimeFormatter TS = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss.SSS");

    private ProcessLog() {
    }

    /**
     * 记录一条流程实例日志;format 支持 slf4j 风格 {@code {}} 与 {@link String#format} 的
     * {@code %s} 两种占位符(按出现顺序对应 args),兼容 delegate 的两种书写习惯。
     */
    public static void log(DelegateExecution execution, String format, Object... args) {
        // DelegateExecution 无 activity name 取值,从当前 BPMN 元素取节点名(未配 name 时为 null)
        FlowElement element = execution.getCurrentFlowElement();
        String line = String.format("%s [%s(%s)] %s%n",
                LocalDateTime.now().format(TS),
                element != null ? element.getName() : null,
                execution.getCurrentActivityId(),
                String.format(toJavaFormat(format), args));
        try {
            Files.createDirectories(LOG_DIR);
            Files.writeString(LOG_DIR.resolve(execution.getProcessInstanceId() + ".log"),
                    line, StandardCharsets.UTF_8, java.nio.file.StandardOpenOption.CREATE,
                    java.nio.file.StandardOpenOption.APPEND);
        } catch (IOException e) {
            // 日志落盘失败不阻断流程,降级到引擎日志告警
            LOG.warn("流程实例日志写入失败 ({}): {}", execution.getProcessInstanceId(), e.toString());
        }
    }

    /** 把消息里的 {@code {}} 占位符逐个替换为 {@code %s};原消息若含裸 % 一并转义,避免 format 失败 */
    private static String toJavaFormat(String format) {
        StringBuilder sb = new StringBuilder(format.length() + 16);
        for (int i = 0; i < format.length(); i++) {
            char c = format.charAt(i);
            if (c == '{' && i + 1 < format.length() && format.charAt(i + 1) == '}') {
                sb.append("%s");
                i++;
            } else if (c == '%') {
                sb.append("%%");
            } else {
                sb.append(c);
            }
        }
        return sb.toString();
    }
}
