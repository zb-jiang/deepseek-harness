package com.expense.sor.web;

import com.expense.sor.config.AppProperties;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Web UI 客户端配置端点(2026-09-24 新增,匿名可访问,已在 SecurityConfig 放行):
 * GET /api/ui-config -> {supabaseUrl, supabaseAnonKey}
 *
 * 仅下发 Supabase 项目 URL 与 anon key —— anon key 是设计上公开的浏览器端客户端密钥
 * (行级安全由 Supabase 负责),不泄露任何服务端密钥(SOR_SERVICE_KEY 绝不出现在此)。
 * 前端登录页需要它来初始化 supabase-js 直连认证中心,认证链路与 SOR 现有 JWT 验签完全一致。
 */
@RestController
public class UiConfigController {

    private final AppProperties props;

    public UiConfigController(AppProperties props) {
        this.props = props;
    }

    @GetMapping("/api/ui-config")
    public Map<String, Object> uiConfig() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("supabaseUrl", props.supabaseUrl() == null ? "" : props.supabaseUrl());
        body.put("supabaseAnonKey", props.supabaseAnonKey() == null ? "" : props.supabaseAnonKey());
        return body;
    }
}
