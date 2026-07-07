"""PARCdata SQL 커넥터 — SQL Server CLR 함수 경유 (구형/SQL 환경).

주의: dataPARC 히스토리는 SQL DB에 직접 저장되지 않는다(파일 기반).
PARCdata 서비스 + CLR 함수(ctc_fn_PARCdata_*)가 배포된 사이트에서만 동작:
  SELECT tagname, [timestamp], value_double, quality
  FROM ctc_fn_PARCdata_ReadRawTags('tag1,tag2', @start, @end, 0)
의존성: pip install pyodbc
"""
from __future__ import annotations

import asyncio

from .base import Connector


class ParcdataSqlConnector(Connector):
    name = "parcdata_sql"

    def __init__(self, cfg: dict):
        self.dsn = cfg["dsn"]
        self.tagmap: dict[str, str] = cfg.get("tags", {}) or {}
        self.rev = {v: k for k, v in self.tagmap.items()}

    async def list_tags(self) -> list[dict]:
        return [{"id": k, "desc": v, "unit": ""} for k, v in self.tagmap.items()]

    def _query(self, remote_ids, start, end):
        import pyodbc  # 지연 임포트
        con = pyodbc.connect(self.dsn, timeout=15)
        try:
            cur = con.cursor()
            cur.execute(
                "SELECT tagname, [timestamp], value_double "
                "FROM ctc_fn_PARCdata_ReadRawTags(?, ?, ?, 0) ORDER BY [timestamp]",
                (",".join(remote_ids), start, end),
            )
            rows = cur.fetchall()
        finally:
            con.close()
        return rows

    async def read_raw(self, tag_ids, start, end):
        remote_ids = [self.tagmap.get(t, t) for t in tag_ids]
        rows = await asyncio.to_thread(self._query, remote_ids, start, end)
        out = {tid: {"t": [], "v": []} for tid in tag_ids}
        for tagname, ts, val in rows:
            local = self.rev.get(tagname, tagname)
            if local not in out or val is None:
                continue
            out[local]["t"].append(int(ts.timestamp() * 1000))
            out[local]["v"].append(float(val))
        return out
