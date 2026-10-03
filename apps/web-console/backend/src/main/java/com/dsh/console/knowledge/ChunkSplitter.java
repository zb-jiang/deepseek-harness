package com.dsh.console.knowledge;

import com.dsh.console.config.KnowledgeProperties;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;
import org.springframework.stereotype.Component;

/**
 * 文本 chunk 拆分:按分隔符切段 → 超长段硬切 → 贪心合并到预算内,相邻 chunk 以
 * 上一 chunk 尾部 overlap 字符衔接。
 *
 * <p>统一模型:每个 chunk = [上一 chunk 尾部(≤ overlap 字符)] + [新内容(≤ maxSize - overlap 字符)],
 * 总长不超过 maxSize。硬切窗口同样按新内容预算切,块间衔接走同一尾部机制。
 * 按 char 截取(不做 codePoint 对齐),切断 emoji 代理对的可能性可接受。
 */
@Component
public class ChunkSplitter {

    /**
     * chunk 拆分参数。入口(上传/重新解析)经 {@link #of} 归一校验后落库与执行。
     *
     * @param maxSize   单 chunk 最大字符数(含 overlap 前缀)
     * @param overlap   相邻 chunk 重叠字符数(尾部衔接)
     * @param separator 优先切分的分隔符(真实字符,如换行符)
     */
    public record ChunkParams(int maxSize, int overlap, String separator) {
        public ChunkParams {
            if (maxSize < 100 || maxSize > 8000) {
                throw new IllegalArgumentException("chunk 最大尺寸必须在 100~8000 字符之间: " + maxSize);
            }
            if (overlap < 0 || overlap >= maxSize / 2) {
                throw new IllegalArgumentException("chunk 重叠必须满足 0 <= overlap < 最大尺寸/2: " + overlap);
            }
            // 分隔符允许纯空白(默认 "\n\n"、预设"空格"),只拒空串与超长
            if (separator == null || separator.isEmpty() || separator.length() > 20) {
                throw new IllegalArgumentException("chunk 分隔符必须是非空且不超过 20 个字符");
            }
        }

        /**
         * 请求参数归一:未指定的项取配置默认值。
         */
        public static ChunkParams of(Integer maxSize, Integer overlap, String separator,
                                     KnowledgeProperties defaults) {
            return new ChunkParams(
                maxSize != null ? maxSize : defaults.chunkMaxSize(),
                overlap != null ? overlap : defaults.chunkOverlap(),
                separator != null && !separator.isBlank() ? separator : defaults.chunkSeparator());
        }
    }

    /**
     * 拆分文本。
     *
     * @param text      抽取全文(空文本返回空列表,文档仅文本检索无向量)
     * @param params    拆分参数
     * @return chunk 文本列表(按原文顺序)
     */
    public List<String> split(String text, ChunkParams params) {
        if (text == null || text.isBlank()) {
            return List.of();
        }
        // 新内容预算:尾部(≤ overlap) + 分隔符 + 正文 ≤ maxSize,正文需扣除前两者
        int budget = params.maxSize() - params.overlap() - params.separator().length();
        List<String> segments = new ArrayList<>();
        for (String part : text.split(Pattern.quote(params.separator()))) {
            String trimmed = part.strip();
            if (trimmed.isEmpty()) {
                continue;
            }
            for (int i = 0; i < trimmed.length(); i += budget) {
                segments.add(trimmed.substring(i, Math.min(i + budget, trimmed.length())));
            }
        }
        List<String> chunks = new ArrayList<>();
        StringBuilder body = null;
        String prevTail = "";
        for (String segment : segments) {
            if (body == null) {
                body = new StringBuilder(segment);
            } else if (body.length() + params.separator().length() + segment.length() <= budget) {
                body.append(params.separator()).append(segment);
            } else {
                String current = body.toString();
                chunks.add(prevTail.isEmpty() ? current : prevTail + params.separator() + current);
                prevTail = params.overlap() > 0 ? tail(current, params.overlap()) : "";
                body = new StringBuilder(segment);
            }
        }
        if (body != null) {
            String current = body.toString();
            chunks.add(prevTail.isEmpty() ? current : prevTail + params.separator() + current);
        }
        return chunks;
    }

    private static String tail(String text, int chars) {
        return text.length() <= chars ? text : text.substring(text.length() - chars);
    }
}
