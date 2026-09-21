package com.dsh.console.backendprofile.dto;

/**
 * skill 归属聚合的单条清单项(GET /api/backend-profiles/skills)。
 *
 * <p>backend profile 按 namespace 拉 SkillHub 清单、按 slug 定位下载,
 * 所以聚合必须带 namespace(应用绑定的 SkillHub namespace),不能只给裸名。
 *
 * @param namespace 应用绑定的 SkillHub namespace
 * @param slug     skill 裸名(dsh:skillRef 值)
 */
public record SkillRequirementDto(String namespace, String slug) {
}
