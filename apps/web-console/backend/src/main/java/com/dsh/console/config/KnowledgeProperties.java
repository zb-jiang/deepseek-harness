package com.dsh.console.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * 知识库模块配置(setup guide §12.4)。
 *
 * <p>绑定 yaml 中 {@code dsh.knowledge.*} 字段。Storage 上传/下载/删除透传用户 JWT
 * (RLS 按应用成员放行),anon key 仅作随附 apikey 头,不引入 service_role。
 *
 * @param supabaseUrl     Supabase 项目 URL(Storage REST 基址,env {@code SUPABASE_URL};缺失启动即失败)
 * @param anonKey         Supabase anon key(env {@code SUPABASE_ANON_KEY};缺失启动即失败)
 * @param tessdataPath    Tesseract 语言训练数据目录(env {@code TESSDATA_PATH};空表示 OCR 不可用,
 *                        图片解析标记 failed,不阻塞其他类型)
 * @param maxUploadSizeMb 单文档上传上限 MB(env {@code KB_MAX_UPLOAD_MB},默认 50;
 *                        与 {@code spring.servlet.multipart} 上限共用同一环境变量)
 */
@ConfigurationProperties(prefix = "dsh.knowledge")
public record KnowledgeProperties(
    String supabaseUrl,
    String anonKey,
    String tessdataPath,
    int maxUploadSizeMb
) {
    public KnowledgeProperties {
        if (supabaseUrl == null || supabaseUrl.isBlank()) {
            throw new IllegalStateException("dsh.knowledge.supabase-url 未配置(环境变量 SUPABASE_URL)");
        }
        if (anonKey == null || anonKey.isBlank()) {
            throw new IllegalStateException("dsh.knowledge.anon-key 未配置(环境变量 SUPABASE_ANON_KEY)");
        }
        if (maxUploadSizeMb <= 0) {
            throw new IllegalStateException("dsh.knowledge.max-upload-size-mb 必须为正整数");
        }
    }

    /**
     * OCR 是否可用(TESSDATA_PATH 已配置)。
     */
    public boolean ocrEnabled() {
        return tessdataPath != null && !tessdataPath.isBlank();
    }
}
