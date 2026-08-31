package com.dsh.console.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * Web MVC 配置:CORS。
 *
 * <p>开发环境前端 Vite dev server 跑在 5173,通过 {@code /api} proxy 转发到 8080;
 * 生产环境前端打包到 static/,与后端同源不需要 CORS。
 * V1 仅放开 localhost:5173 用于开发,生产关闭。
 */
@Configuration
public class WebConfig implements WebMvcConfigurer {

    @Override
    public void addCorsMappings(CorsRegistry registry) {
        // 仅 /api/** 走 CORS;静态资源同源不需要
        registry.addMapping("/api/**")
            .allowedOriginPatterns("http://localhost:*", "http://127.0.0.1:*")
            .allowedMethods("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS")
            .allowedHeaders("*")
            .allowCredentials(true)
            .maxAge(3600);
    }
}
