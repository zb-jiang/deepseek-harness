package com.dsh.console.knowledge.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.util.UUID;

/**
 * 建文件夹请求。
 *
 * @param name     文件夹名(同层唯一;不允许含 '/')
 * @param parentId 父文件夹 id(null = 根)
 */
public record CreateFolderRequest(
    @NotBlank(message = "文件夹名不能为空") @Size(max = 100, message = "文件夹名最长 100 字符") String name,
    UUID parentId
) {
}
