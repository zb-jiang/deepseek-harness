package com.dsh.flowable.api;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;

/**
 * /dsh/skills/required 出参:当前用户需要的 skill 清单。
 *
 * @param name     skill 名(dsh:skillRef 裸名,员工端按 SkillHub latest 解析)
 * @param namespace SkillHub 命名空间(下载定位用);流程定义无法映射到应用时为 null
 * @param sources  需求来源(active-task=当前待办;deployed-definition=已部署
 *                 流程定义静态解析的将来需求)
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record SkillRequirementDto(String name, String namespace, List<String> sources) {
}
