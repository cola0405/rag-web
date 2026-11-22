"""RAG Web 应用入口。

启动（项目根目录）：
    uvicorn web.app:app --reload --port 8000
"""

from __future__ import annotations

import logging
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from rag_core import KBService  # noqa: E402
from rag_core.embeddings import PROVIDER_PRESETS, ProviderRegistry  # noqa: E402
from rag_core.exceptions import KnowledgeBaseUploadError  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("rag-web")

DATA_DIR = Path(os.getenv("RAG_DATA_DIR", str(ROOT / "data"))).resolve()
registry = ProviderRegistry(DATA_DIR / "embedding_providers.json")
service = KBService(DATA_DIR, registry.providers)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await service.initialize()
    logger.info("RAG 服务已就绪，数据目录: %s", DATA_DIR)
    yield
    await service.close()


app = FastAPI(title="RAG Web Knowledge Base", version="0.1.0", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=ROOT / "web" / "static"), name="static")


def _handle(exc: Exception):
    if isinstance(exc, (ValueError, KnowledgeBaseUploadError)):
        message = exc.user_message if isinstance(exc, KnowledgeBaseUploadError) else str(exc)
        raise HTTPException(status_code=400, detail=message) from exc
    logger.exception("请求处理失败: %s", exc)
    raise HTTPException(status_code=500, detail=str(exc)) from exc


class CreateKBRequest(BaseModel):
    kb_name: str
    description: str | None = None
    embedding_provider_id: str = "local-hash"
    chunk_size: int = 512
    chunk_overlap: int = 50


class ProviderRequest(BaseModel):
    id: str
    name: str | None = None
    base_url: str
    model: str
    api_key: str = ""
    dim: int = 1024
    dimensions: int | None = None


class RetrieveRequest(BaseModel):
    query: str
    kb_names: list[str] = Field(default_factory=list)


@app.get("/")
async def index():
    return FileResponse(ROOT / "web" / "static" / "index.html")


@app.get("/api/health")
async def health():
    return {"status": "ok", "data_dir": str(DATA_DIR)}


@app.get("/api/embedding-presets")
async def list_embedding_presets():
    return PROVIDER_PRESETS


@app.get("/api/providers")
async def list_providers():
    return registry.list()


@app.post("/api/providers")
async def add_provider(payload: ProviderRequest):
    # 已有知识库用着这个 provider 时不允许改维度：FAISS 索引维度已固定
    old = registry.providers.get(payload.id)
    if old and old.get_dim() != payload.dim:
        users = [
            inst.kb.kb_name
            for inst in service.kb_insts.values()
            if inst.kb.embedding_provider_id == payload.id
        ]
        if users:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"知识库 {', '.join(users)} 正在使用该 provider，"
                    f"维度不能从 {old.get_dim()} 改为 {payload.dim}；请换一个 provider ID。"
                ),
            )
    try:
        return registry.add(payload.model_dump())
    except Exception as exc:
        _handle(exc)


@app.post("/api/providers/{provider_id}/test")
async def test_provider(provider_id: str):
    try:
        return await registry.test(provider_id)
    except Exception as exc:
        _handle(exc)


@app.delete("/api/providers/{provider_id}")
async def remove_provider(provider_id: str):
    users = [
        inst.kb.kb_name
        for inst in service.kb_insts.values()
        if inst.kb.embedding_provider_id == provider_id
    ]
    if users:
        raise HTTPException(
            status_code=400,
            detail=f"知识库 {', '.join(users)} 正在使用该 provider，请先删除这些知识库。",
        )
    try:
        registry.remove(provider_id)
    except Exception as exc:
        _handle(exc)
    return {"ok": True}


@app.get("/api/kbs")
async def list_kbs():
    return await service.list_kbs()


@app.post("/api/kbs")
async def create_kb(payload: CreateKBRequest):
    try:
        instance = await service.create_kb(
            kb_name=payload.kb_name,
            description=payload.description,
            embedding_provider_id=payload.embedding_provider_id,
            chunk_size=payload.chunk_size,
            chunk_overlap=payload.chunk_overlap,
        )
    except Exception as exc:
        _handle(exc)
    return {
        "kb_id": instance.kb.kb_id,
        "kb_name": instance.kb.kb_name,
    }


@app.delete("/api/kbs/{kb_id}")
async def delete_kb(kb_id: str):
    if not await service.delete_kb(kb_id):
        raise HTTPException(status_code=404, detail="知识库不存在")
    return {"ok": True}


@app.get("/api/kbs/{kb_id}/documents")
async def list_documents(kb_id: str):
    return await service.list_documents(kb_id)


@app.post("/api/kbs/{kb_id}/documents")
async def upload_document(kb_id: str, file: UploadFile = File(...)):
    content = await file.read()
    try:
        return await service.upload_document(kb_id, file.filename or "untitled.txt", content)
    except Exception as exc:
        _handle(exc)


@app.delete("/api/kbs/{kb_id}/documents/{doc_id}")
async def delete_document(kb_id: str, doc_id: str):
    if not await service.delete_document(kb_id, doc_id):
        raise HTTPException(status_code=404, detail="文档不存在")
    return {"ok": True}


@app.post("/api/retrieve")
async def retrieve(payload: RetrieveRequest):
    try:
        return await service.retrieve(payload.query, payload.kb_names)
    except Exception as exc:
        _handle(exc)
