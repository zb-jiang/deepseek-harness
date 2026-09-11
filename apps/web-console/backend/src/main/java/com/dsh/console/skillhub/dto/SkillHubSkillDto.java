package com.dsh.console.skillhub.dto;

/**
 * SkillHub namespace 下已发布 skill 条目。
 *
 * <p>对应 SkillHub {@code GET /api/cli/v1/namespaces/{ns}/skills} 响应 data.items
 * 元素的裁剪视图,只保留 Web Console 前端选择/展示所需字段。
 *
 * @param slug       skill 唯一标识(namespace 内)
 * @param version     latest 版本号
 * @param fingerprint 内容指纹
 * @param updatedAt  最新发布时间
 */
public record SkillHubSkillDto(String slug, String version, String fingerprint, String updatedAt) {
}
