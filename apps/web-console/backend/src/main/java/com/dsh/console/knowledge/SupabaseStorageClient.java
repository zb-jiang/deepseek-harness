package com.dsh.console.knowledge;

import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import com.dsh.console.config.KnowledgeProperties;

/**
 * Supabase Storage REST 客户端(仅知识库桶,认证经透传用户 JWT,RLS 按应用成员放行)。
 *
 * <p>纪律:不引入 service_role key; anon key 只作 apikey 头(RestClientConfig 已设)。
 * 只在请求线程调用——解析管线直接消费上传时的字节,不经 Storage 回读。
 *
 * <p>对象路径按段做 UTF-8 百分号编码(文档名可含中文/空格),数据库存原始路径;
 * 请求 URI 由本类拼成绝对地址(见 {@link #objectUri}),RestClient bean 的 baseUrl 仅作兜底。
 */
@Component
public class SupabaseStorageClient {

    private final RestClient restClient;
    private final KnowledgeProperties properties;

    public SupabaseStorageClient(RestClient supabaseStorageRestClient, KnowledgeProperties properties) {
        this.restClient = supabaseStorageRestClient;
        this.properties = properties;
    }

    /**
     * 上传对象(路径不存在则创建;同路径重复上传由 Storage 返回 409,调用方保证路径唯一)。
     *
     * @param bucket     桶名(公共桶 kb-documents,一次性手工预建)
     * @param objectPath 桶内对象路径({appId}/{docId}/document{ext},应用间分段隔离)
     * @param content    文件字节
     * @param contentType MIME 类型(未知用 application/octet-stream)
     */
    public void upload(String bucket, String objectPath, byte[] content, String contentType) {
        try {
            restClient.post()
                .uri(objectUri(bucket, objectPath))
                .header("Content-Type", contentType)
                .body(content)
                .retrieve()
                .toBodilessEntity();
        } catch (Exception e) {
            throw new KbStorageException("上传文档到 Storage 失败: " + e.getMessage(), e);
        }
    }

    /**
     * 下载对象原文。
     *
     * @return 文件字节(单文档上限 50MB,整载内存可接受)
     */
    public byte[] download(String bucket, String objectPath) {
        try {
            return restClient.get()
                .uri(objectUri(bucket, objectPath))
                .retrieve()
                .body(byte[].class);
        } catch (Exception e) {
            throw new KbStorageException("从 Storage 下载文档失败: " + e.getMessage(), e);
        }
    }

    /**
     * 删除对象。
     */
    public void delete(String bucket, String objectPath) {
        try {
            restClient.delete()
                .uri(objectUri(bucket, objectPath))
                .retrieve()
                .toBodilessEntity();
        } catch (Exception e) {
            throw new KbStorageException("从 Storage 删除文档失败: " + e.getMessage(), e);
        }
    }

    /**
     * 对象 URL:按段编码后拼成绝对 URI。
     *
     * <p>不走 RestClient 的 baseUrl——它只对 {@code uri(String)} 模板合并,而传 {@code uri(URI)}
     * 对象时按原样使用,相对 URI 会以 "URI is not absolute" 失败;URI 模板变量又会把 '/'
     * 编码成 %2F,故手工按段编码后拼绝对地址。
     */
    private URI objectUri(String bucket, String objectPath) {
        String encoded = java.util.Arrays.stream(objectPath.split("/"))
            .map(SupabaseStorageClient::encodeSegment)
            .reduce("/storage/v1/object/" + encodeSegment(bucket), (acc, seg) -> acc + "/" + seg);
        String base = properties.supabaseUrl();
        String trimmed = base.endsWith("/") ? base.substring(0, base.length() - 1) : base;
        return URI.create(trimmed + encoded);
    }

    private static String encodeSegment(String segment) {
        return URLEncoder.encode(segment, StandardCharsets.UTF_8).replace("+", "%20");
    }
}
