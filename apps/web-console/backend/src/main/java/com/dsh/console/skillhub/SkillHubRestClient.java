package com.dsh.console.skillhub;

import com.dsh.console.config.SkillHubProperties;
import com.dsh.console.skillhub.dto.SkillHubSkillDto;
import com.fasterxml.jackson.databind.JsonNode;
import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;
import org.springframework.http.HttpHeaders;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;
import org.springframework.web.util.UriBuilder;

/**
 * SkillHub REST API 薄封装。
 *
 * <p>Web Console 后端持只读 API token 代理浏览器访问企业 Skill 仓库,认证头为静态
 * {@code Authorization: Bearer <rawToken>}(区别于 Flowable 客户端的用户 JWT 透传),
 * 由本客户端在每个请求上设置。
 *
 * <p>信封:SkillHub 响应为 {@code {code,msg,data}},成功 code=0;list 端点 data 为
 * {@code {items,nextCursor}},cursor 是下一页页码字符串,末页为 null。
 *
 * <p>错误语义:HTTP 5xx / 网络失败抛 {@code RestClientException} 由
 * {@link com.dsh.console.common.GlobalExceptionHandler} 转 502;信封失败抛
 * {@code IllegalStateException}。{@link #namespaceExists} 例外:404、信封失败
 * 或任何调用异常均视为不存在,返回 false。
 */
@Component("skillHubServiceClient")
public class SkillHubRestClient {

    /** 信封成功 code 值(SkillHub ApiResponseFactory.ok 恒为 0)。 */
    private static final int ENVELOPE_OK = 0;

    private static final int PAGE_LIMIT = 100;

    private final RestClient skillHubRestClient;
    private final SkillHubProperties properties;

    public SkillHubRestClient(RestClient skillHubRestClient, SkillHubProperties properties) {
        this.skillHubRestClient = skillHubRestClient;
        this.properties = properties;
    }

    /**
     * 列 namespace 下全部已发布 skill(翻页拉全)。
     *
     * @param namespace SkillHub namespace slug
     * @return 已发布 skill 清单(跨全部页聚合)
     * @throws IllegalStateException {@code dsh.skillhub.api-token} 未配置或信封失败
     * @throws RestClientException   SkillHub 不可达 / 5xx(转 502)
     */
    public List<SkillHubSkillDto> listNamespaceSkills(String namespace) {
        String token = requireToken();
        List<SkillHubSkillDto> result = new ArrayList<>();
        String cursor = "0";
        while (cursor != null && !cursor.isBlank()) {
            final String cursorParam = cursor;
            JsonNode data = fetchEnvelope(token,
                uriBuilder -> uriBuilder
                    .path("/api/cli/v1/namespaces/{ns}/skills")
                    .queryParam("cursor", cursorParam)
                    .queryParam("limit", PAGE_LIMIT)
                    .build(namespace));
            for (JsonNode item : data.path("items")) {
                result.add(new SkillHubSkillDto(
                    item.path("slug").asText(null),
                    item.path("version").asText(null),
                    item.path("fingerprint").asText(null),
                    item.path("updatedAt").asText(null)));
            }
            cursor = data.path("nextCursor").asText(null);
        }
        return result;
    }

    /**
     * 校验 namespace 是否存在。
     *
     * <p>调 SkillHub {@code GET /api/v1/namespaces/{slug}} 单查端点(任何有效 token
     * 可读,无 scope 要求)。404、信封失败或任何调用异常(含 5xx / 网络失败)均视为
     * 不存在,返回 false。
     */
    public boolean namespaceExists(String namespace) {
        try {
            String token = requireToken();
            fetchEnvelope(token, uriBuilder -> uriBuilder
                .path("/api/v1/namespaces/{slug}")
                .build(namespace));
            return true;
        } catch (RestClientException | IllegalStateException e) {
            return false;
        }
    }

    /**
     * 发 GET 请求并解信封,返回 data 节点。
     *
     * @throws IllegalStateException token 未配置或信封 code 非 0
     */
    private JsonNode fetchEnvelope(String token, Function<UriBuilder, URI> uri) {
        JsonNode resp = skillHubRestClient.get()
            .uri(uri)
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + token)
            .retrieve()
            .body(JsonNode.class);
        if (resp == null || resp.path("code").asInt(-1) != ENVELOPE_OK) {
            throw new IllegalStateException("SkillHub 响应信封失败: " + (resp == null ? "空响应" : resp.toString()));
        }
        return resp.path("data");
    }

    /** token 未配置时 fail loud(未集成 SkillHub 的部署在首次实际调用时报错)。 */
    private String requireToken() {
        String token = properties.apiToken();
        if (token == null || token.isBlank()) {
            throw new IllegalStateException("dsh.skillhub.api-token 未配置");
        }
        return token;
    }
}
