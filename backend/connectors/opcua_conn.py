"""OPC UA 커넥터 — dataPARC UA 서버 (범용 폴백, 구버전 dataPARC 포함).

엔드포인트 예: opc.tcp://SERVER:51235/Capstone/OPCUAServer
HistoryRead(read_raw)로 과거 데이터, 현재값은 read_value.
의존성: pip install asyncua
"""
from __future__ import annotations

from .base import Connector


class OpcuaConnector(Connector):
    name = "opcua"

    def __init__(self, cfg: dict):
        self.endpoint = cfg["endpoint"]
        self.auth = cfg.get("auth", "anonymous")
        self.username = cfg.get("username")
        self.password = cfg.get("password")
        self.tagmap: dict[str, str] = cfg.get("tags", {}) or {}
        self._client = None

    async def start(self) -> None:
        from asyncua import Client  # 지연 임포트 — 미설치 시 다른 커넥터에 영향 없음
        self._client = Client(url=self.endpoint)
        if self.auth == "username" and self.username:
            self._client.set_user(self.username)
            self._client.set_password(self.password or "")
        await self._client.connect()

    async def stop(self) -> None:
        if self._client:
            await self._client.disconnect()

    async def list_tags(self) -> list[dict]:
        return [{"id": k, "desc": v, "unit": ""} for k, v in self.tagmap.items()]

    async def read_raw(self, tag_ids, start, end):
        assert self._client is not None, "start() 미호출"
        out = {}
        for tid in tag_ids:
            node_id = self.tagmap.get(tid, tid)
            node = self._client.get_node(node_id)
            t, v = [], []
            try:
                history = await node.read_raw_history(start, end)
                for dv in history:
                    ts = dv.SourceTimestamp or dv.ServerTimestamp
                    if ts is None or dv.Value is None:
                        continue
                    try:
                        v.append(float(dv.Value.Value))
                        t.append(int(ts.timestamp() * 1000))
                    except (TypeError, ValueError):
                        continue
            except Exception:  # 노드별 실패는 건너뛰고 계속 (히스토리 미지원 노드 등)
                pass
            # UA는 최신→과거 순서로 줄 수 있으므로 정렬
            pair = sorted(zip(t, v))
            out[tid] = {"t": [p[0] for p in pair], "v": [p[1] for p in pair]}
        return out
