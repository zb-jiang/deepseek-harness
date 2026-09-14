package com.dsh.console.knowledge.dto;

import java.util.UUID;

/**
 * 当前用户可见的知识库清单项({@code GET /api/kb/mine}):应用与其知识库的
 * 联查投影,供员工端「上传到知识库」选应用(design 2026-09-11 §6)。
 *
 * @param kbId            知识库 id
 * @param applicationId   所属应用 id
 * @param applicationName 应用名(展示与排序)
 * @param kbName          知识库名
 */
public record KbAppSummaryDto(
    UUID kbId,
    UUID applicationId,
    String applicationName,
    String kbName
) {
}
