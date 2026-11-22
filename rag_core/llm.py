"""LLM provider 注册与对话：OpenAI 兼容 /chat/completions 协议。

配置保存在 data/llm_providers.json（已被 .gitignore 排除），包含 provider 列表、
当前启用的 provider 和生成参数。API Key 只写本地文件，接口不回传明文。
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path

logger = logging.getLogger("rag")

LLM_PRESETS: list[dict] = [
    {
        "id": "openai",
        "name": "OpenAI",
        "base_url": "https://api.openai.com/v1",
        "model": "gpt-4o-mini",
        "needs_key": True,
        "note": "海外服务，需可访问 OpenAI。",
    },
    {
        "id": "dashscope",
        "name": "阿里百炼 DashScope",
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "model": "qwen-plus",
        "needs_key": True,
        "note": "兼容模式地址，模型名可按账号开通情况修改。",
    },
    {
        "id": "siliconflow",
        "name": "硅基流动 SiliconFlow",
        "base_url": "https://api.siliconflow.cn/v1",
        "model": "Qwen/Qwen2.5-7B-Instruct",
        "needs_key": True,
        "note": "国内可直接访问，部分模型有免费额度。",
    },
    {
        "id": "zhipu",
        "name": "智谱 BigModel",
        "base_url": "https://open.bigmodel.cn/api/paas/v4",
        "model": "glm-4-flash",
        "needs_key": True,
        "note": "glm-4-flash 为免费模型，适合先跑通链路。",
    },
    {
        "id": "deepseek",
        "name": "DeepSeek",
        "base_url": "https://api.deepseek.com/v1",
        "model": "deepseek-chat",
        "needs_key": True,
        "note": "OpenAI 兼容接口，模型名一般为 deepseek-chat。",
    },
    {
        "id": "ollama",
        "name": "本地 Ollama",
        "base_url": "http://localhost:11434/v1",
        "model": "qwen2.5",
        "needs_key": False,
        "note": "需先 ollama pull qwen2.5；无需 API Key。",
    },
    {
        "id": "custom",
        "name": "自定义 OpenAI 兼容服务",
        "base_url": "",
        "model": "",
        "needs_key": False,
        "note": "任何提供 /v1/chat/completions 的服务，包括自建代理。",
    },
]

DEFAULT_SETTINGS: dict = {
    "temperature": 0.2,
    "max_tokens": 1024,
    "system_prompt": (
        "你是知识库问答助手。只依据提供的知识库片段回答问题；"
        "如果片段不足以回答，明确说明当前知识库没有相关信息，不要编造。"
        "回答简洁、条理清晰，并在使用到某条资料时用 [编号] 标注来源。"
    ),
}

_ID_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,39}")


class LLMProvider:
    """最小 OpenAI 兼容对话客户端。"""

    def __init__(
        self,
        provider_id: str,
        base_url: str,
        model: str,
        api_key: str = "",
    ) -> None:
        self.provider_id = provider_id
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_key = api_key

    async def chat(
        self,
        messages: list[dict],
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> tuple[str, dict]:
        import httpx

        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        payload: dict = {"model": self.model, "messages": messages}
        if temperature is not None:
            payload["temperature"] = temperature
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens

        url = f"{self.base_url}/chat/completions"
        try:
            async with httpx.AsyncClient(timeout=120) as client:
                response = await client.post(url, headers=headers, json=payload)
        except Exception as exc:
            raise ValueError(f"无法连接 LLM 服务 {self.base_url}：{exc}") from exc
        if response.status_code >= 400:
            raise ValueError(f"LLM 请求失败（{response.status_code}）：{response.text[:300]}")
        try:
            data = response.json()
            message = data["choices"][0]["message"]
            content = message.get("content", "")
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise ValueError(f"LLM 返回格式不符合预期：{response.text[:300]}") from exc
        if isinstance(content, list):
            content = "".join(
                part.get("text", "") for part in content if isinstance(part, dict)
            )
        return str(content or "").strip(), dict(data.get("usage") or {})


class LLMRegistry:
    """LLM provider 注册表：增删改查、启用、测试和生成参数持久化。"""

    def __init__(self, config_path: str | Path | None = None) -> None:
        self.config_path = Path(config_path) if config_path else None
        self.configs: dict[str, dict] = {}
        self.active_id: str | None = None
        self.settings: dict = DEFAULT_SETTINGS.copy()

        if self.config_path and self.config_path.exists():
            try:
                saved = json.loads(self.config_path.read_text(encoding="utf-8"))
                if isinstance(saved, dict):
                    for item in saved.get("providers", []):
                        if isinstance(item, dict) and item.get("id"):
                            self.configs[item["id"]] = item
                    self.active_id = saved.get("active_id") or None
                    saved_settings = saved.get("settings")
                    if isinstance(saved_settings, dict):
                        self.settings.update(
                            {k: v for k, v in saved_settings.items() if k in DEFAULT_SETTINGS}
                        )
            except Exception as exc:
                logger.warning("读取 LLM 配置失败: %s", exc)

        if self.active_id not in self.configs:
            self.active_id = next(iter(self.configs), None)

    # ---------- 公开视图 ----------

    def list(self) -> list[dict]:
        return [
            {
                "id": provider_id,
                "name": config.get("name", provider_id),
                "model": config.get("model", ""),
                "base_url": config.get("base_url", ""),
                "has_key": bool(config.get("api_key")),
                "is_active": provider_id == self.active_id,
                "source": config.get("source", "manual"),
            }
            for provider_id, config in self.configs.items()
        ]

    def get_config(self) -> dict:
        return {
            "providers": self.list(),
            "active_id": self.active_id,
            "settings": dict(self.settings),
            "presets": LLM_PRESETS,
        }

    # ---------- 配置变更 ----------

    def add(self, config: dict) -> dict:
        provider_id = str(config.get("id", "")).strip()
        if not _ID_PATTERN.fullmatch(provider_id):
            raise ValueError("Provider ID 只能用字母、数字、下划线和连字符，且不超过 40 字符")
        base_url = str(config.get("base_url", "")).strip()
        model = str(config.get("model", "")).strip()
        if not base_url.startswith(("http://", "https://")):
            raise ValueError("base_url 必须是 http:// 或 https:// 开头的完整地址")
        if not model:
            raise ValueError("模型名称不能为空")

        old = self.configs.get(provider_id)
        api_key = str(config.get("api_key", "")).strip()
        if not api_key and old and not config.get("clear_api_key"):
            api_key = str(old.get("api_key", ""))

        saved = {
            "id": provider_id,
            "name": str(config.get("name") or provider_id),
            "base_url": base_url,
            "model": model,
            "api_key": api_key,
            "source": "manual",
        }
        self.configs[provider_id] = saved
        if not self.active_id:
            self.active_id = provider_id
        self.save()
        return self._public(saved)

    def _public(self, config: dict) -> dict:
        provider_id = config["id"]
        return {
            "id": provider_id,
            "name": config.get("name", provider_id),
            "model": config.get("model", ""),
            "base_url": config.get("base_url", ""),
            "has_key": bool(config.get("api_key")),
            "is_active": provider_id == self.active_id,
            "source": config.get("source", "manual"),
        }

    def remove(self, provider_id: str) -> None:
        if provider_id not in self.configs:
            raise ValueError(f"Provider '{provider_id}' 不存在")
        self.configs.pop(provider_id)
        if self.active_id == provider_id:
            self.active_id = next(iter(self.configs), None)
        self.save()

    def activate(self, provider_id: str) -> dict:
        if provider_id not in self.configs:
            raise ValueError(f"Provider '{provider_id}' 不存在")
        self.active_id = provider_id
        self.save()
        return {"active_id": provider_id}

    def update_settings(self, payload: dict) -> dict:
        try:
            temperature = float(payload.get("temperature", self.settings["temperature"]))
        except (TypeError, ValueError) as exc:
            raise ValueError("temperature 必须是数字") from exc
        if not 0 <= temperature <= 2:
            raise ValueError("temperature 必须在 0 ~ 2 之间")
        try:
            max_tokens = int(payload.get("max_tokens", self.settings["max_tokens"]))
        except (TypeError, ValueError) as exc:
            raise ValueError("max_tokens 必须是整数") from exc
        if not 1 <= max_tokens <= 8192:
            raise ValueError("max_tokens 必须在 1 ~ 8192 之间")
        system_prompt = str(payload.get("system_prompt", self.settings["system_prompt"]))
        if len(system_prompt) > 4000:
            raise ValueError("系统提示词不能超过 4000 字符")
        self.settings = {
            "temperature": temperature,
            "max_tokens": max_tokens,
            "system_prompt": system_prompt,
        }
        self.save()
        return dict(self.settings)

    # ---------- 调用 ----------

    def _provider(self, provider_id: str) -> LLMProvider:
        config = self.configs.get(provider_id)
        if not config:
            raise ValueError(f"Provider '{provider_id}' 不存在")
        return LLMProvider(
            provider_id=provider_id,
            base_url=str(config.get("base_url", "")),
            model=str(config.get("model", "")),
            api_key=str(config.get("api_key", "")),
        )

    async def test(self, provider_id: str) -> dict:
        provider = self._provider(provider_id)
        answer, _ = await provider.chat(
            [{"role": "user", "content": "请只回复 OK"}],
            temperature=0,
            max_tokens=16,
        )
        return {"id": provider_id, "reply": answer[:200]}

    async def chat(self, messages: list[dict]) -> tuple[str, dict]:
        if not self.active_id:
            raise ValueError("尚未启用 LLM 模型，请先在「LLM 配置」中添加并启用")
        provider = self._provider(self.active_id)
        return await provider.chat(
            messages,
            temperature=float(self.settings["temperature"]),
            max_tokens=int(self.settings["max_tokens"]),
        )

    def save(self) -> None:
        if not self.config_path:
            return
        self.config_path.parent.mkdir(parents=True, exist_ok=True)
        self.config_path.write_text(
            json.dumps(
                {
                    "active_id": self.active_id,
                    "settings": self.settings,
                    "providers": list(self.configs.values()),
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )

