package com.dsh.flowable.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * DSH headless profile 集成配置:定制 delegate 通过
 * {@link com.dsh.flowable.delegate.DshHeadlessClient} 启动 headless 一次性任务进程执行 LLM。
 *
 * <p>命令行 {@code <nodeBin> --import tsx/esm <cliEntry> --profile headless "<task>"},
 * 在 {@code repoRoot} 目录下启动子进程,stdout 收到的最终 assistant 文本即调用产出。
 *
 * <p>子进程继承引擎进程的环境变量:必须有 {@code DEEPSEEK_API_KEY}(headless 的 LLM 调用读它);
 * {@code node} 必须在引擎进程的 PATH 上。
 *
 * @param nodeBin            Node 可执行文件名或绝对路径(默认 {@code node},要求在 PATH 上)
 * @param repoRoot           DSH 仓库根目录(含 {@code apps/cli} 与根 {@code node_modules});
 *                            对应环境变量 {@code DSH_REPO_ROOT}。可选:无自动节点的部署可留空,
 *                            {@code DshHeadlessClient} 在调用期校验并抛异常
 * @param cliEntry           仓库根目录下的 dsh CLI 入口(默认 {@code apps/cli/src/bin.ts})
 * @param callTimeoutSeconds 单次 headless 调用超时(秒);超时强制结束子进程并抛异常,
 *                           触发调用方的 async Job 重试。LLM(含 thinking)耗时可超过 1 分钟,默认 300
 */
@ConfigurationProperties(prefix = "dsh.headless")
public record DshHeadlessProperties(
    String nodeBin,
    String repoRoot,
    String cliEntry,
    long callTimeoutSeconds
) {
    public DshHeadlessProperties {
        nodeBin = nodeBin == null || nodeBin.isBlank() ? "node" : nodeBin.trim();
        repoRoot = repoRoot == null ? "" : repoRoot.trim();
        cliEntry = cliEntry == null || cliEntry.isBlank() ? "apps/cli/src/bin.ts" : cliEntry.trim();
    }

    /** 默认 300 秒;LLM 平均耗时长于 HTTP 服务,超时后由 async-executor 按重试周期重试。 */
    public long callTimeoutSeconds() {
        return callTimeoutSeconds <= 0 ? 300 : callTimeoutSeconds;
    }
}
