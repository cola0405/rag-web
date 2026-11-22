"""RAG 知识库核心：SQLite 元数据 + FAISS + FTS5/BM25 混合检索。"""

from .service import KBService

__all__ = ["KBService"]
