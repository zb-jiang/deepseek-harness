package com.dsh.console.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpHeaders;
import org.springframework.http.client.ClientHttpRequestInterceptor;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.client.RestClient;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

/**
 * RestClient 配置:调用 Flowable 引擎 REST。
 *
 * <p>认证模型为"认证直连 Supabase"(参见 SPEC §7.2 与 Supabase 手册 §0):
 * <ul>
 *   <li>用户调 Web Console 时带 {@code Authorization: Bearer <supabase jwt>},Web Console 后端
 *       用 Supabase JWT Secret 本地验证(见 {@code SecurityConfig})。</li>
 *   <li>Web Console 调 Flowable REST 时把当前请求的 JWT 透传过去;Flowable 引擎同样用
 *       Supabase JWT Secret 验证,无需 server-to-server 共享密钥或 basic auth。</li>
 * </ul>
 *
 * <p>因此本配置不引入 {@code BasicAuthenticationInterceptor},仅在出站请求上补 Authorization 头。
 * 超时 30 秒;V1 单企业单实例够用,后续可换 HttpComponents client 支持连接池。
 *
 * <p>线程边界:本 bean 是单例,interceptor 通过 {@link RequestContextHolder} 拿当前线程
 * 绑定的请求;后台线程(如异步任务)无请求上下文时,interceptor 不补头,由调用方自行处理。
 */
@Configuration
public class RestClientConfig {

    private final FlowableRestProperties properties;

    public RestClientConfig(FlowableRestProperties properties) {
        this.properties = properties;
    }

    /**
     * Flowable REST 客户端:base URL + 透传 JWT + 10s/30s 超时。
     */
    @Bean
    public RestClient flowableRestClient() {
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(10_000);   // 10 秒
        factory.setReadTimeout(30_000);      // 30 秒
        return RestClient.builder()
            .baseUrl(properties.baseUrl())
            .requestFactory(factory)
            .requestInterceptor(forwardAuthHeader())
            .build();
    }

    /**
     * 透传当前请求的 Authorization 头给 Flowable 引擎。
     *
     * <p>无请求上下文(异步线程、定时任务)时不补头,由调用方负责自行注入。
     */
    private ClientHttpRequestInterceptor forwardAuthHeader() {
        return (request, body, execution) -> {
            ServletRequestAttributes attrs =
                (ServletRequestAttributes) RequestContextHolder.getRequestAttributes();
            if (attrs != null) {
                String auth = attrs.getRequest().getHeader(HttpHeaders.AUTHORIZATION);
                if (auth != null && !auth.isBlank()) {
                    request.getHeaders().set(HttpHeaders.AUTHORIZATION, auth);
                }
            }
            return execution.execute(request, body);
        };
    }
}
