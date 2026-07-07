"""커넥터 공통 인터페이스.

모든 커넥터는 (태그ID, 시작, 끝) → [{t: epoch_ms, v: float}] 형태로 통일한다.
웹앱은 이 게이트웨이의 REST만 알면 되고, dataPARC 접속 방식은 여기서 흡수한다.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime


class Connector(ABC):
    name = "base"

    async def start(self) -> None:  # 연결 초기화 (필요 시 오버라이드)
        return None

    async def stop(self) -> None:
        return None

    @abstractmethod
    async def list_tags(self) -> list[dict]:
        """[{id, desc, unit}] 반환."""

    @abstractmethod
    async def read_raw(self, tag_ids: list[str], start: datetime, end: datetime) -> dict[str, dict]:
        """{tagId: {"t": [epoch_ms...], "v": [float...]}} 반환."""

    async def read_current(self, tag_ids: list[str]) -> dict[str, float]:
        from datetime import timedelta, timezone
        end = datetime.now(timezone.utc)
        data = await self.read_raw(tag_ids, end - timedelta(minutes=30), end)
        out = {}
        for k, s in data.items():
            if s["v"]:
                out[k] = s["v"][-1]
        return out
