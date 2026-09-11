package com.dsh.console.knowledge;

import com.dsh.console.knowledge.dto.KbDocumentDto;
import jakarta.annotation.PreDestroy;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * 文档异步解析管线:上传请求线程把字节交给单线程 executor,Tika/OCR 抽取后回写
 * {@code text_content} 与 {@code parse_status};解析失败记 {@code failed} + 原因,不重抛。
 *
 * <p>单线程串行保证解析不互相挤占内存(单文档上限 50MB)。服务重启会丢队列中未解析任务,
 * 受影响文档停留在 pending,重新上传即可恢复——量级上百、失败可感知,不做持久化队列。
 */
@Service
public class KbParsePipeline {

    private static final Logger log = LoggerFactory.getLogger(KbParsePipeline.class);

    private final DocumentParser parser;
    private final KnowledgeJdbcRepository repository;
    private final ExecutorService executor = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "kb-parse");
        thread.setDaemon(true);
        return thread;
    });

    public KbParsePipeline(DocumentParser parser, KnowledgeJdbcRepository repository) {
        this.parser = parser;
        this.repository = repository;
    }

    /**
     * 提交解析任务(上传成功、元数据行已落库后调用)。
     */
    public void submit(UUID docId, String name, byte[] content) {
        executor.execute(() -> parse(docId, name, content));
    }

    private void parse(UUID docId, String name, byte[] content) {
        try {
            String text = parser.extract(name, content);
            repository.updateParseResult(docId, KbDocumentDto.STATUS_READY, text, null);
            log.info("KB document parsed: {} ({})", name, docId);
        } catch (Throwable e) {
            // 解析失败不重抛:单个文档的失败标记 failed 即可,管线继续处理后续文档。
            // catch Throwable 而非 Exception:Tika 依赖冲突等 LinkageError(NoSuchMethodError)不属于 Exception,
            // 漏掉会把单线程池的 worker 直接打死。
            log.error("KB document parse failed: {} ({})", name, docId, e);
            repository.updateParseResult(docId, KbDocumentDto.STATUS_FAILED, null,
                e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
        }
    }

    @PreDestroy
    void shutdown() {
        executor.shutdownNow();
    }
}
