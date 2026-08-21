package com.dsh.flowable;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

/**
 * DSH 企业级应用平台 Flowable 引擎服务入口。
 *
 * <p>独立 Spring Boot 进程,连接 Supabase Postgres 的 {@code flowable} schema 自动建 {@code ACT_*} 表,
 * 暴露 Flowable 官方 REST API({@code /process-api/*})与少量 DSH 自定义薄封装端点({@code /dsh/*})。
 * 认证基于 Supabase Auth 签发的 HS256 JWT,用 Supabase JWT Secret 在本地验证(见 §10.2)。
 */
@SpringBootApplication
@ConfigurationPropertiesScan
public class FlowableEngineApplication {

    public static void main(String[] args) {
        SpringApplication.run(FlowableEngineApplication.class, args);
    }
}
