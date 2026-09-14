package com.dsh.console.knowledge.dto;

import java.util.UUID;

/**
 * 文档抽取全文读取项(员工端 kb_read 工具消费;design 2026-09-11 §6)。
 *
 * <p>按 docId 直查,不按 (kbId, docId) 组合——工具入参只有 docId,KB 归属与
 * 成员校验在服务层从行内 kb_id 推导。响应携带 kbId,模型读完即可衔接着
 * 用 kb_search / kb_list(它们以 kbId 为入参)。
 *
 * @param id          文档 id
 * @param kbId        所属知识库 id(模型从 docId 反查知识库的唯一来源)
 * @param name        文档名
 * @param textContent 抽取/OCR 全文(未解析完成或无文本时为 null)
 * @param parseStatus 解析状态:pending / ready / failed(工具据此提示「解析中/失败」)
 */
public record KbDocumentTextDto(
    UUID id,
    UUID kbId,
    String name,
    String textContent,
    String parseStatus
) {
}
