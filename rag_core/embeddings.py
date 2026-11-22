"""Embedding / Rerank 接口与两个可直接使用的实现。

从 AstrBot 的 provider 体系里剥离出最小契约：
- get_embedding / get_embeddings / get_dim / get_embeddings_batch

默认 `local-hash` 是纯本地确定性哈希向量，零配置即可跑通全流程；
`openai` 走 OpenAI 兼容的 /embeddings 接口，用于真实语义检索。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
from pathlib import Path

import jieba
import numpy as np

logger = logging.getLogger("rag")


class EmbeddingProvider:
    """向量化 provider 的最小契约（与 AstrBot 同名方法兼容）。"""

    def __init__(self, provider_id: str = "embedding") -> None:
        self.provider_id = provider_id

    async def get_embedding(self, text: str) -> list[float]:
        raise NotImplementedError

    async def get_embeddings(self, texts: list[str]) -> list[list[float]]:
        raise NotImplementedError

    def get_dim(self) -> int:
        raise NotImplementedError

    async def get_embeddings_batch(
        self,
        texts: list[str],
        batch_size: int = 32,
        tasks_limit: int = 3,
        max_retries: int = 3,
        progress_callback=None,
    ) -> list[list[float]]:
        """分批 + 有限并发 + 指数退避，逻辑与 AstrBot 原实现一致。"""
        semaphore = asyncio.Semaphore(tasks_limit)
        batch_results: dict[int, list[list[float]]] = {}
        completed = 0

        async def process_batch(idx: int, batch: list[str]) -> None:
            nonlocal completed
            async with semaphore:
                for attempt in range(max_retries):
                    try:
                        batch_results[idx] = await self.get_embeddings(batch)
                        completed += len(batch)
                        if progress_callback:
                            await progress_callback(completed, len(texts))
                        return
                    except Exception:
                        if attempt == max_retries - 1:
                            raise
                        await asyncio.sleep(2**attempt)

        tasks = [
            process_batch(i // batch_size, texts[i : i + batch_size])
            for i in range(0, len(texts), batch_size)
        ]
        await asyncio.gather(*tasks)
        result: list[list[float]] = []
        for idx in range(len(tasks)):
            result.extend(batch_results[idx])
        return result


class RerankProvider:
    """重排序契约占位；本示例默认不启用 rerank。"""

    async def rerank(
        self, query: str, documents: list[str], top_n: int | None = None
    ) -> list:
        raise NotImplementedError


_CJK = re.compile(r"[\u3400-\u9fff]")


class HashEmbeddingProvider(EmbeddingProvider):
    """零依赖本地向量：jieba 词 + 中文字符二元组，哈希投影后 L2 归一化。

    不是语义向量，但同词/同字片段能稳定召回，足以在没有 API key 的机器上
    验证「上传 → 分块 → 入库 → 混合检索」整条链路。
    """

    def __init__(self, dim: int = 512) -> None:
        super().__init__("local-hash")
        self.dim = dim

    def get_dim(self) -> int:
        return self.dim

    def _features(self, text: str) -> list[str]:
        text = text or ""
        tokens = [t.strip() for t in jieba.cut(text.lower()) if t.strip()]
        features: list[str] = list(tokens)
        for token in tokens:
            if len(token) >= 2:
                features.extend(token[i : i + 2] for i in range(len(token) - 1))
            if len(token) == 1 and _CJK.search(token):
                features.append(token)
        return features

    def _encode(self, text: str) -> list[float]:
        vec = np.zeros(self.dim, dtype=np.float32)
        for feature in self._features(text):
            digest = hashlib.blake2b(feature.encode("utf-8"), digest_size=8).digest()
            idx = int.from_bytes(digest[:4], "little") % self.dim
            sign = 1.0 if digest[4] & 1 else -1.0
            vec[idx] += sign
        norm = float(np.linalg.norm(vec))
        if norm:
            vec /= norm
        return vec.tolist()

    async def get_embedding(self, text: str) -> list[float]:
        return self._encode(text)

    async def get_embeddings(self, texts: list[str]) -> list[list[float]]:
        return [self._encode(t) for t in texts]


class OpenAIEmbeddingProvider(EmbeddingProvider):
    """OpenAI 兼容 embedding 接口（DashScope / Ollama / 自建服务均可）。"""

    def __init__(
        self,
        base_url: str,
        model: str,
        api_key: str = "",
        dim: int = 1024,
        provider_id: str = "openai",
        dimensions: int | None = None,
    ) -> None:
        super().__init__(provider_id)
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_key = api_key
        self.dim = dim
        # 部分服务商（百炼 / 智谱）需要在请求体里显式指定输出维度
        self.dimensions = dimensions

    def get_dim(self) -> int:
        return self.dim

    async def get_embedding(self, text: str) -> list[float]:
        return (await self.get_embeddings([text]))[0]

    async def get_embeddings(self, texts: list[str]) -> list[list[float]]:
        import httpx

        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        payload = {"model": self.model, "input": texts}
        if self.dimensions is not None:
            payload["dimensions"] = self.dimensions
        async with httpx.AsyncClient(timeout=120) as client:
            response = await client.post(
                f"{self.base_url}/embeddings",
                headers=headers,
                json=payload,
            )
            response.raise_for_status()
            data = response.json()["data"]
        data.sort(key=lambda item: item.get("index", 0))
        vectors = [item["embedding"] for item in data]
        if len(vectors) != len(texts):
            raise ValueError(
                f"embedding 返回数量不一致: 期望 {len(texts)}, 实际 {len(vectors)}"
            )
        return vectors


# 常见 OpenAI 兼容云端 Embedding 服务预设。dimensions 为请求体里可选的输出维度参数。
PROVIDER_PRESETS: list[dict] = [
    {
        "id": "openai",
        "name": "OpenAI",
        "base_url": "https://api.openai.com/v1",
        "model": "text-embedding-3-small",
        "dim": 1536,
        "dimensions": None,
        "needs_key": True,
        "note": "海外服务，需可访问 OpenAI。",
    },
    {
        "id": "dashscope",
        "name": "阿里百炼 DashScope",
        "base_url": "https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
        "model": "text-embedding-v3",
        "dim": 1024,
        "dimensions": 1024,
        "needs_key": True,
        "note": "把 {WorkspaceId} 换成百炼业务空间 ID；旧版兼容地址 https://dashscope.aliyuncs.com/compatible-mode/v1 也可填。",
    },
    {
        "id": "siliconflow",
        "name": "硅基流动 SiliconFlow",
        "base_url": "https://api.siliconflow.cn/v1",
        "model": "BAAI/bge-m3",
        "dim": 1024,
        "dimensions": None,
        "needs_key": True,
        "note": "bge-m3 有免费额度，中文效果好，输出固定 1024 维。",
    },
    {
        "id": "zhipu",
        "name": "智谱 BigModel",
        "base_url": "https://open.bigmodel.cn/api/paas/v4",
        "model": "embedding-3",
        "dim": 1024,
        "dimensions": 1024,
        "needs_key": True,
        "note": "embedding-3 默认 2048 维，此处显式指定 1024；可改为 256/512/2048。",
    },
    {
        "id": "nvidia",
        "name": "NVIDIA NIM",
        "base_url": "https://integrate.api.nvidia.com/v1",
        "model": "nvidia/nv-embedqa-e5-v5",
        "dim": 1024,
        "dimensions": None,
        "needs_key": True,
        "note": "需要 NVIDIA API Key。",
    },
    {
        "id": "ollama",
        "name": "本地 Ollama（非云端）",
        "base_url": "http://localhost:11434/v1",
        "model": "nomic-embed-text",
        "dim": 768,
        "dimensions": None,
        "needs_key": False,
        "note": "走同样协议但完全本地，无需 key；需先 ollama pull nomic-embed-text。",
    },
    {
        "id": "custom",
        "name": "自定义 OpenAI 兼容服务",
        "base_url": "",
        "model": "",
        "dim": 1024,
        "dimensions": None,
        "needs_key": False,
        "note": "任何提供 /v1/embeddings 的服务，包括自建代理。",
    },
]

_RESERVED_PROVIDER_ID = "local-hash"


class ProviderRegistry:
    """Embedding provider 注册表：本地哈希 + 动态云端 provider + 配置持久化。"""

    def __init__(self, config_path: str | Path | None = None) -> None:
        self.config_path = Path(config_path) if config_path else None
        self.providers: dict[str, EmbeddingProvider] = {
            _RESERVED_PROVIDER_ID: HashEmbeddingProvider()
        }
        self.configs: dict[str, dict] = {}

        if self.config_path and self.config_path.exists():
            try:
                saved = json.loads(self.config_path.read_text(encoding="utf-8"))
                for item in saved if isinstance(saved, list) else []:
                    if isinstance(item, dict) and item.get("id"):
                        self.configs[item["id"]] = item
            except Exception as exc:
                logger.warning("读取 Embedding 配置失败: %s", exc)

        for config in self.configs.values():
            self._instantiate(config)

        # 兼容原有环境变量配置（不落盘，重启后由环境变量重新提供）
        env_base_url = os.getenv("RAG_OPENAI_BASE_URL", "").strip()
        if env_base_url and "openai" not in self.providers:
            config = {
                "id": "openai",
                "name": "OpenAI（环境变量）",
                "base_url": env_base_url,
                "model": os.getenv("RAG_OPENAI_MODEL", "text-embedding-v3"),
                "api_key": os.getenv("RAG_OPENAI_API_KEY", ""),
                "dim": int(os.getenv("RAG_OPENAI_DIM", "1024")),
                "dimensions": None,
                "source": "env",
            }
            self.configs["openai"] = config
            self._instantiate(config)

    def _instantiate(self, config: dict) -> None:
        self.providers[config["id"]] = OpenAIEmbeddingProvider(
            base_url=str(config.get("base_url", "")),
            model=str(config.get("model", "")),
            api_key=str(config.get("api_key", "")),
            dim=int(config.get("dim", 1024)),
            dimensions=config.get("dimensions"),
            provider_id=config["id"],
        )

    def list(self) -> list[dict]:
        result = [
            {
                "id": _RESERVED_PROVIDER_ID,
                "name": "本地哈希向量（零配置）",
                "type": "HashEmbeddingProvider",
                "dim": self.providers[_RESERVED_PROVIDER_ID].get_dim(),
                "source": "builtin",
                "has_key": False,
            }
        ]
        for provider_id, config in self.configs.items():
            result.append(
                {
                    "id": provider_id,
                    "name": config.get("name", provider_id),
                    "type": "OpenAIEmbeddingProvider",
                    "dim": config.get("dim"),
                    "base_url": config.get("base_url", ""),
                    "model": config.get("model", ""),
                    "dimensions": config.get("dimensions"),
                    "source": config.get("source", "manual"),
                    "has_key": bool(config.get("api_key")),
                }
            )
        return result

    def add(self, config: dict) -> dict:
        """新增或原地更新一个云端 provider。"""
        provider_id = str(config.get("id", "")).strip()
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,39}", provider_id):
            raise ValueError("provider ID 只能用字母、数字、下划线和连字符，且不超过 40 字符")
        if provider_id == _RESERVED_PROVIDER_ID:
            raise ValueError("local-hash 是内置 provider，不能覆盖")
        base_url = str(config.get("base_url", "")).strip()
        model = str(config.get("model", "")).strip()
        if not base_url.startswith(("http://", "https://")):
            raise ValueError("base_url 必须是 http:// 或 https:// 开头的完整地址")
        if not model:
            raise ValueError("模型名称不能为空")
        try:
            dim = int(config.get("dim", 1024))
        except (TypeError, ValueError) as exc:
            raise ValueError("维度必须是整数") from exc
        if dim <= 0 or dim > 8192:
            raise ValueError("维度必须在 1 ~ 8192 之间")

        dimensions = config.get("dimensions")
        if dimensions in ("", None):
            dimensions = None
        else:
            try:
                dimensions = int(dimensions)
            except (TypeError, ValueError) as exc:
                raise ValueError("dimensions 必须是整数或留空") from exc

        saved = {
            "id": provider_id,
            "name": str(config.get("name") or provider_id),
            "base_url": base_url,
            "model": model,
            "api_key": str(config.get("api_key", "")),
            "dim": dim,
            "dimensions": dimensions,
            "source": "manual",
        }

        # 原地更新已有对象，避免已加载知识库持有旧 provider 引用
        existing = self.providers.get(provider_id)
        if isinstance(existing, OpenAIEmbeddingProvider):
            existing.base_url = base_url
            existing.model = model
            existing.api_key = saved["api_key"]
            existing.dim = dim
            existing.dimensions = dimensions
        else:
            self._instantiate(saved)

        self.configs[provider_id] = saved
        self.save()
        return {k: v for k, v in saved.items() if k != "api_key"} | {
            "has_key": bool(saved["api_key"])
        }

    def remove(self, provider_id: str) -> None:
        if provider_id == _RESERVED_PROVIDER_ID:
            raise ValueError("不能删除内置 provider")
        if provider_id not in self.configs:
            raise ValueError(f"provider '{provider_id}' 不存在")
        self.configs.pop(provider_id)
        self.providers.pop(provider_id, None)
        self.save()

    async def test(self, provider_id: str) -> dict:
        provider = self.providers.get(provider_id)
        if not provider:
            raise ValueError(f"provider '{provider_id}' 不存在")
        vector = await provider.get_embedding("embedding 连通性测试")
        actual = len(vector)
        return {
            "id": provider_id,
            "actual_dim": actual,
            "expected_dim": provider.get_dim(),
            "match": actual == provider.get_dim(),
        }

    def save(self) -> None:
        if not self.config_path:
            return
        self.config_path.parent.mkdir(parents=True, exist_ok=True)
        self.config_path.write_text(
            json.dumps(list(self.configs.values()), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
