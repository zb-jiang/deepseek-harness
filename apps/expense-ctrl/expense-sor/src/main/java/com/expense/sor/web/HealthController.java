package com.expense.sor.web;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/** 健康检查:免认证,直接返回 {"status":"UP"}(设计文档 §4),不包裹统一信封。 */
@RestController
@RequestMapping("/api/health")
@RawResponse
public class HealthController {

    @GetMapping
    public Map<String, String> health() {
        return Map.of("status", "UP");
    }
}
