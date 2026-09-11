package com.dsh.console.knowledge.dto;

import java.time.OffsetDateTime;
import java.util.UUID;

/**
 * 知识库文件夹({@code kb_folders} 表)。
 *
 * @param id        文件夹 id
 * @param kbId      所属知识库
 * @param parentId  父文件夹 id(null = 根)
 * @param name      文件夹名(同层唯一)
 * @param path      物化路径(根下 '/财务',子级 '/财务/报销';子树检索按前缀匹配)
 * @param createdAt 创建时间
 */
public record KbFolderDto(
    UUID id,
    UUID kbId,
    UUID parentId,
    String name,
    String path,
    OffsetDateTime createdAt
) {
}
