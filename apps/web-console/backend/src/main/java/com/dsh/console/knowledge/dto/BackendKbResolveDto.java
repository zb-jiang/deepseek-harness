package com.dsh.console.knowledge.dto;

import java.util.UUID;

/**
 * 流程归属知识库解析结果(backend profile 无人值守任务用)。
 *
 * @param kbId   知识库 id,backend task payload 与 kb_* 工具的范围锚点
 * @param kbName 知识库名,注入会话 kb 上下文块供模型识别
 */
public record BackendKbResolveDto(
    UUID kbId,
    String kbName
) {
}
