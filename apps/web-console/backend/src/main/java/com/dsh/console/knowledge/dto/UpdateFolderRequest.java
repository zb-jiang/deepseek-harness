package com.dsh.console.knowledge.dto;

import jakarta.validation.constraints.Size;
import java.util.UUID;

/**
 * 重命名/移动文件夹请求(至少给一个字段;两者可同时给)。
 *
 * @param name     新名字(null 表示不改名)
 * @param parentId 新父文件夹 id(null 表示不移动;显式移动到根传根的语义由本字段非空判断,
 *                 故移动到根不支持——根级文件夹本就无层级差异,统一约定:只改名不移动时本字段必须为 null)
 */
public record UpdateFolderRequest(
    @Size(max = 100, message = "文件夹名最长 100 字符") String name,
    UUID parentId
) {
}
