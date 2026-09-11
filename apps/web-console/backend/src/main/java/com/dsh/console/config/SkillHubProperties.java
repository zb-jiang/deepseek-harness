package com.dsh.console.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * SkillHub REST 客户端配置。
 *
 * <p>绑定 yaml 中 {@code dsh.skillhub.*} 字段。Web Console 后端持只读 API token
 * 代理浏览器访问企业 Skill 仓库(SkillHub),浏览器不直连。
 *
 * <p>token 走环境变量 {@code SKILLHUB_API_TOKEN} 注入,不落仓库;未集成 SkillHub
 * 的部署可留空,仅在应用绑定 namespace / 发布校验实际调用时才要求非空(fail loud)。
 *
 * @param baseUrl  SkillHub base URL(默认 http://127.0.0.1:8095)
 * @param apiToken 只读 API token(raw token,请求头 {@code Authorization: Bearer <token>})
 */
@ConfigurationProperties(prefix = "dsh.skillhub")
public record SkillHubProperties(String baseUrl, String apiToken) {
}
