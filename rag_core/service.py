"""知识库业务服务：封装知识库与文档的完整生命周期。

三表元数据、FAISS 向量库、FTS5/BM25 稀疏检索和
稠密/稀疏加权融合构成检索核心；不依赖插件系统或框架级 provider 管理。
"""

from __future__ import annotations

import io
import logging
import shutil
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy.exc import IntegrityError
from sqlmodel import select, col

from .chunking.base import BaseChunker
from .chunking.markdown import MarkdownChunker
from .chunking.recursive import RecursiveCharacterChunker
from .embeddings import EmbeddingProvider
from .exceptions import KnowledgeBaseUploadError
from .kb_db import KBSQLiteDatabase
from .models import KBDocument, KnowledgeBase
from .retrieval.manager import RetrievalManager
from .retrieval.rank_fusion import RankFusion
from .retrieval.sparse_retriever import SparseRetriever
from .vec_db.faiss_impl import FaissVecDB

logger = logging.getLogger("rag")

CHUNKER: BaseChunker = RecursiveCharacterChunker()
MARKDOWN_EXTENSIONS = {".md", ".markdown", ".mdx", ".mkd", ".rst"}


@dataclass
class KBInstance:
    """RetrievalManager 所需的最小实例对象。"""

    kb: KnowledgeBase
    vec_db: FaissVecDB | None = None
    init_error: str | None = None


def _kb_to_dict(kb: KnowledgeBase) -> dict:
    return {
        "kb_id": kb.kb_id,
        "kb_name": kb.kb_name,
        "description": kb.description,
        "emoji": kb.emoji,
        "embedding_provider_id": kb.embedding_provider_id,
        "chunk_size": kb.chunk_size,
        "chunk_overlap": kb.chunk_overlap,
        "top_k_dense": kb.top_k_dense,
        "top_k_sparse": kb.top_k_sparse,
        "top_m_final": kb.top_m_final,
        "doc_count": kb.doc_count,
        "chunk_count": kb.chunk_count,
        "created_at": kb.created_at.isoformat() if kb.created_at else None,
        "updated_at": kb.updated_at.isoformat() if kb.updated_at else None,
    }


def _doc_to_dict(doc: KBDocument) -> dict:
    return {
        "doc_id": doc.doc_id,
        "kb_id": doc.kb_id,
        "doc_name": doc.doc_name,
        "file_type": doc.file_type,
        "file_size": doc.file_size,
        "chunk_count": doc.chunk_count,
        "created_at": doc.created_at.isoformat() if doc.created_at else None,
    }


class KBService:
    def __init__(self, data_dir: str | Path, providers: dict[str, EmbeddingProvider]):
        self.data_dir = Path(data_dir).resolve()
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.providers = providers
        self.kb_insts: dict[str, KBInstance] = {}
        self.kb_db = KBSQLiteDatabase(str(self.data_dir / "kb.db"))
        self.retrieval_manager: RetrievalManager | None = None

    async def initialize(self) -> None:
        await self.kb_db.initialize()
        await self.kb_db.migrate_to_v1()
        self.retrieval_manager = RetrievalManager(
            sparse_retriever=SparseRetriever(self.kb_db),
            rank_fusion=RankFusion(self.kb_db),
            kb_db=self.kb_db,
        )
        for record in await self.kb_db.list_kbs(limit=1000):
            instance = await self._build_instance(record)
            self.kb_insts[record.kb_id] = instance

    async def close(self) -> None:
        for instance in self.kb_insts.values():
            if instance.vec_db:
                await instance.vec_db.close()
        self.kb_insts.clear()
        await self.kb_db.close()

    # ---------- 实例管理 ----------

    async def _build_instance(self, kb: KnowledgeBase) -> KBInstance:
        instance = KBInstance(kb=kb)
        try:
            provider = self.providers.get(kb.embedding_provider_id or "")
            if provider is None:
                raise ValueError(f"Embedding provider '{kb.embedding_provider_id}' 未配置")
            kb_dir = self.data_dir / kb.kb_id
            kb_dir.mkdir(parents=True, exist_ok=True)
            vec_db = FaissVecDB(
                doc_store_path=str(kb_dir / "doc.db"),
                index_store_path=str(kb_dir / "index.faiss"),
                embedding_provider=provider,
            )
            await vec_db.initialize()
            instance.vec_db = vec_db
        except Exception as exc:  # 知识库仍可见，但检索时会被跳过
            instance.init_error = str(exc)
            logger.warning("知识库 %s 初始化失败: %s", kb.kb_name, exc)
        return instance

    async def list_kbs(self) -> list[dict]:
        return [_kb_to_dict(inst.kb) for inst in self.kb_insts.values()]

    async def get_kb(self, kb_id: str) -> KBInstance | None:
        return self.kb_insts.get(kb_id)

    async def get_kb_by_name(self, name: str) -> KBInstance | None:
        for inst in self.kb_insts.values():
            if inst.kb.kb_name == name:
                return inst
        return self.kb_insts.get(name)

    async def create_kb(
        self,
        kb_name: str,
        description: str | None = None,
        embedding_provider_id: str = "local-hash",
        chunk_size: int = 512,
        chunk_overlap: int = 50,
        top_k_dense: int = 50,
        top_k_sparse: int = 50,
        top_m_final: int = 5,
    ) -> KBInstance:
        kb_name = kb_name.strip()
        if not kb_name:
            raise ValueError("知识库名称不能为空")
        if embedding_provider_id not in self.providers:
            raise ValueError(
                f"未知的 embedding provider: {embedding_provider_id}；"
                f"可用: {', '.join(self.providers)}"
            )
        if await self.kb_db.get_kb_by_name(kb_name):
            raise ValueError(f"知识库名称 '{kb_name}' 已存在")

        kb = KnowledgeBase(
            kb_name=kb_name,
            description=description,
            emoji="📚",
            embedding_provider_id=embedding_provider_id,
            chunk_size=chunk_size,
            chunk_overlap=chunk_overlap,
            top_k_dense=top_k_dense,
            top_k_sparse=top_k_sparse,
            top_m_final=top_m_final,
        )
        async with self.kb_db.get_db() as session:
            try:
                session.add(kb)
                await session.commit()
                await session.refresh(kb)
            except IntegrityError as exc:
                raise ValueError(f"知识库名称 '{kb_name}' 已存在") from exc

        instance = await self._build_instance(kb)
        self.kb_insts[kb.kb_id] = instance
        if instance.init_error:
            raise ValueError(f"知识库初始化失败: {instance.init_error}")
        return instance

    async def delete_kb(self, kb_id: str) -> bool:
        instance = self.kb_insts.get(kb_id)
        if not instance:
            return False
        if instance.vec_db:
            await instance.vec_db.close()
        kb_dir = self.data_dir / kb_id
        if kb_dir.exists():
            shutil.rmtree(kb_dir)
        async with self.kb_db.get_db() as session:
            await session.delete(instance.kb)
            await session.commit()
        self.kb_insts.pop(kb_id, None)
        return True

    # ---------- 文档管理 ----------

    @staticmethod
    def _parse_text(file_name: str, content: bytes) -> str:
        ext = Path(file_name).suffix.lower()
        if ext == ".pdf":
            try:
                from pypdf import PdfReader

                reader = PdfReader(io.BytesIO(content))
                pages = [page.extract_text() or "" for page in reader.pages]
                return "\n\n".join(pages)
            except Exception as exc:
                raise KnowledgeBaseUploadError(
                    "parsing", f"PDF 解析失败: {exc}", {"file_name": file_name}
                ) from exc
        for encoding in ("utf-8", "utf-8-sig", "gbk", "gb18030"):
            try:
                return content.decode(encoding)
            except UnicodeDecodeError:
                continue
        raise KnowledgeBaseUploadError(
            "parsing", f"无法解码文件: {file_name}", {"file_name": file_name}
        )

    async def upload_document(
        self, kb_id: str, file_name: str, content: bytes
    ) -> dict:
        instance = self.kb_insts.get(kb_id)
        if not instance or not instance.vec_db:
            raise ValueError(f"知识库 {kb_id} 不可用: {instance.init_error if instance else '未找到'}")
        kb = instance.kb
        vec_db: FaissVecDB = instance.vec_db
        doc_id = str(uuid.uuid4())
        ext = Path(file_name).suffix.lower() or ".txt"

        text = self._parse_text(file_name, content)
        if not text.strip():
            raise KnowledgeBaseUploadError(
                "parsing", "未能从文件中提取可索引文本", {"file_name": file_name}
            )

        chunker = (
            MarkdownChunker(
                chunk_size=kb.chunk_size or 512,
                chunk_overlap=kb.chunk_overlap or 50,
            )
            if ext in MARKDOWN_EXTENSIONS
            else CHUNKER
        )
        chunks = await chunker.chunk(
            text,
            chunk_size=kb.chunk_size or 512,
            chunk_overlap=kb.chunk_overlap or 50,
        )
        chunks = [c.strip() for c in chunks if c and c.strip()]
        if not chunks:
            raise KnowledgeBaseUploadError("chunking", "分块结果为空")

        title = Path(file_name).stem.strip()
        embedding_texts = [f"{title}\n\n{c}" for c in chunks] if title else chunks
        contents = chunks
        metadatas = [
            {"kb_id": kb.kb_id, "kb_doc_id": doc_id, "chunk_index": i}
            for i in range(len(chunks))
        ]

        try:
            await vec_db.insert_batch(
                contents=contents,
                metadatas=metadatas,
                embedding_contents=embedding_texts,
            )
        except Exception:
            await vec_db.delete_documents(metadata_filters={"kb_doc_id": doc_id})
            raise

        files_dir = self.data_dir / kb.kb_id / "files"
        files_dir.mkdir(parents=True, exist_ok=True)
        file_path = files_dir / f"{doc_id}{ext}"
        file_path.write_bytes(content)

        doc = KBDocument(
            doc_id=doc_id,
            kb_id=kb.kb_id,
            doc_name=file_name,
            file_type=ext.lstrip("."),
            file_size=len(content),
            file_path=str(file_path),
            chunk_count=len(chunks),
            media_count=0,
        )
        try:
            async with self.kb_db.get_db() as session:
                session.add(doc)
                await session.commit()
                await session.refresh(doc)
        except Exception:
            await vec_db.delete_documents(metadata_filters={"kb_doc_id": doc_id})
            file_path.unlink(missing_ok=True)
            raise

        await self.kb_db.update_kb_stats(kb_id=kb.kb_id, vec_db=vec_db)
        await self._sync_kb(kb)
        return _doc_to_dict(doc)

    async def _sync_kb(self, kb: KnowledgeBase) -> None:
        """把数据库里的统计值同步回常驻内存的实例对象。"""
        fresh = await self.kb_db.get_kb_by_id(kb.kb_id)
        if fresh:
            kb.doc_count = fresh.doc_count
            kb.chunk_count = fresh.chunk_count
            kb.updated_at = fresh.updated_at

    async def list_documents(self, kb_id: str) -> list[dict]:
        docs = await self.kb_db.list_documents_by_kb(kb_id, limit=500)
        return [_doc_to_dict(doc) for doc in docs]

    async def delete_document(self, kb_id: str, doc_id: str) -> bool:
        instance = self.kb_insts.get(kb_id)
        if not instance:
            return False
        doc = await self.kb_db.get_document_by_id(doc_id)
        if not doc or doc.kb_id != kb_id:
            return False
        if instance.vec_db:
            await self.kb_db.delete_document_by_id(doc_id, instance.vec_db)
        else:
            async with self.kb_db.get_db() as session:
                await session.delete(doc)
                await session.commit()
        if doc.file_path:
            Path(doc.file_path).unlink(missing_ok=True)
        if instance.vec_db:
            await self.kb_db.update_kb_stats(kb_id=kb_id, vec_db=instance.vec_db)
            await self._sync_kb(instance.kb)
        return True

    # ---------- 检索 ----------

    async def retrieve(self, query: str, kb_names: list[str]) -> dict:
        if not query.strip():
            raise ValueError("检索问题不能为空")
        if not kb_names:
            kb_names = [inst.kb.kb_name for inst in self.kb_insts.values()]

        kb_ids: list[str] = []
        kb_id_helper_map: dict[str, KBInstance] = {}
        unavailable: list[str] = []
        for name in kb_names:
            inst = await self.get_kb_by_name(name)
            if not inst:
                continue
            if inst.init_error or not inst.vec_db:
                unavailable.append(f"{name}: {inst.init_error}")
                continue
            kb_ids.append(inst.kb.kb_id)
            kb_id_helper_map[inst.kb.kb_id] = inst

        if not kb_ids:
            if unavailable:
                raise ValueError("请求的知识库均不可用: " + "; ".join(unavailable))
            return {"context_text": "", "results": []}

        assert self.retrieval_manager is not None
        results = await self.retrieval_manager.retrieve(
            query=query,
            kb_ids=kb_ids,
            kb_id_helper_map=kb_id_helper_map,
        )
        if not results:
            return {"context_text": "", "results": []}

        lines = ["以下是相关的知识库内容，请参考这些信息回答用户的问题:\n"]
        results_dict = []
        for i, result in enumerate(results, 1):
            lines.extend(
                [
                    f"【知识 {i}】",
                    f"来源: {result.kb_name} / {result.doc_name}",
                    f"内容: {result.content}",
                    f"相关度: {result.score:.2f}",
                    "",
                ]
            )
            results_dict.append(
                {
                    "chunk_id": result.chunk_id,
                    "doc_id": result.doc_id,
                    "kb_id": result.kb_id,
                    "kb_name": result.kb_name,
                    "doc_name": result.doc_name,
                    "chunk_index": result.metadata.get("chunk_index", 0),
                    "content": result.content,
                    "score": result.score,
                }
            )
        return {"context_text": "\n".join(lines), "results": results_dict}
