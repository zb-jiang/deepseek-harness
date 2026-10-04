package com.dsh.console.common;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpHeaders;
import org.springframework.web.bind.annotation.ControllerAdvice;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.servlet.resource.NoResourceFoundException;

/**
 * 前端打包进 jar 后的 SPA history 路由回退:浏览器直接刷新前端路由(如 /apps/{id})时
 * 没有对应静态资源,Spring 资源处理器抛 NoResourceFoundException,否则会被兜底
 * {@code @ExceptionHandler(Exception.class)} 处理成 500。
 *
 * <p>GET 且接受 HTML 的非 /api/ 请求转发到 /index.html,由前端路由接管;
 * 其余情形(未知 API 路径、非 HTML 的资源请求)维持 404,不再伪装成 500。</p>
 */
@ControllerAdvice
@Order(Ordered.HIGHEST_PRECEDENCE)
public class SpaFallbackExceptionHandler {

    private static final String API_PREFIX = "/api/";

    @ExceptionHandler(NoResourceFoundException.class)
    public String handleNoResource(NoResourceFoundException ex, HttpServletRequest request,
                                   HttpServletResponse response) throws Exception {
        String accept = request.getHeader(HttpHeaders.ACCEPT);
        if (!request.getRequestURI().startsWith(API_PREFIX)
                && "GET".equals(request.getMethod())
                && accept != null
                && accept.contains("text/html")) {
            return "forward:/index.html";
        }
        response.sendError(HttpServletResponse.SC_NOT_FOUND);
        return null;
    }
}
