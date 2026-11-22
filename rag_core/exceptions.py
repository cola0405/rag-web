"""独立的异常类型（不依赖任何框架的异常体系）。"""


class KnowledgeBaseUploadError(Exception):
    """知识库写入过程中的可解释错误。"""

    def __init__(self, stage: str, user_message: str, details: dict | None = None):
        super().__init__(user_message)
        self.stage = stage
        self.user_message = user_message
        self.details = details or {}
