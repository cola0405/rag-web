"""本地模拟 OpenAI /v1/embeddings 接口，用于在没有 API Key 时验证云端调用链路。

启动：
    python scripts/mock_embedding_server.py --port 8100

然后在 Web 界面的「Embedding 模型管理」里添加 provider：
    base_url = http://127.0.0.1:8100/v1
    model    = mock-embed
    dim      = 1024
"""

from __future__ import annotations

import argparse
import hashlib

import numpy as np
from fastapi import FastAPI
from pydantic import BaseModel, Field
import uvicorn

app = FastAPI(title="Mock Embedding Server")


class EmbeddingRequest(BaseModel):
    model: str = "mock-embed"
    input: list[str] | str
    dimensions: int | None = None


@app.post("/v1/embeddings")
async def embeddings(payload: EmbeddingRequest):
    texts = [payload.input] if isinstance(payload.input, str) else payload.input
    dim = payload.dimensions or 1024
    data = []
    for index, text in enumerate(texts):
        vec = np.zeros(dim, dtype=np.float32)
        for word in text.lower().split():
            digest = hashlib.blake2b(word.encode("utf-8"), digest_size=8).digest()
            slot = int.from_bytes(digest[:4], "little") % dim
            vec[slot] += 1.0 if digest[4] & 1 else -1.0
        norm = float(np.linalg.norm(vec))
        if norm:
            vec /= norm
        data.append({"index": index, "object": "embedding", "embedding": vec.tolist()})
    return {"object": "list", "model": payload.model, "data": data}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8100)
    args = parser.parse_args()
    uvicorn.run(app, host="127.0.0.1", port=args.port)
