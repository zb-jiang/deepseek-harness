package com.dsh.flowable.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * 服务器端 DSH web profile daemon 回调配置(参见 Supabase 手册 §10.4)。
 *
 * <p>Flowable 引擎执行自动节点时,通过 {@link com.dsh.flowable.delegate.DshServiceTaskDelegate}
 * 用 WebClient HTTP 调本配置指向的 DSH web profile daemon,触发自动节点的 LLM/skill/脚本执行。
 *
 * <p>V1 假设同机部署,通过 {@code 127.0.0.1:3080} 回调;若拆分机器,改 base-url 即可。
 *
 * @param baseUrl              DSH web profile 根地址(如 {@code http://127.0.0.1:3080})
 * @param autoNodePath          自动节点执行端点路径(如 {@code /api/enterprise/auto-node/execute})
 * @param callTimeoutSeconds    HTTP 调用超时(秒);超时后抛异常触发自动节点失败处理(SPEC §9.3)
 */
@ConfigurationProperties(prefix = "dsh.web-profile")
public record DshWebProfileProperties(
    String baseUrl,
    String autoNodePath,
    long callTimeoutSeconds
) {
    /**
     * 默认 60 秒超时;LLM 调用可能耗时较长,V1 用同步阻塞,V2 可改异步 + Job 轮询。
     */
    public long callTimeoutSeconds() {
        return callTimeoutSeconds <= 0 ? 60 : callTimeoutSeconds;
    }
}
