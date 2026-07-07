# MEDI PdM 게이트웨이 (공장 PC용)

dataPARC의 태그 데이터를 웹앱이 읽을 수 있는 통일된 REST API로 변환하는 브릿지입니다.
**공장 내부망의 PC(dataPARC 접근 가능한 PC)에서 실행**합니다.

```
[현장 계기/DCS] → [dataPARC (PARCserver/Store)] → [이 게이트웨이] → [웹앱 index.html]
```

## 1. 설치

```bash
cd backend
python -m venv venv
venv\Scripts\activate          # Windows / (Linux: source venv/bin/activate)
pip install -r requirements.txt
```

OPC UA 커넥터를 쓰면 `pip install asyncua`, PARCdata SQL을 쓰면 `pip install pyodbc` 추가.

## 2. 설정

```bash
copy config.example.yaml config.yaml    # Windows / (Linux: cp)
```

`config.yaml`에서 `connector:` 를 선택하고 해당 섹션을 채웁니다.

### 어떤 커넥터를 써야 하나? (사이트 dataPARC 버전에 따라)

| 우선순위 | 커넥터 | 대상 | 확인 방법 |
|---|---|---|---|
| ① | `dataparc_rest` | 신형 dataPARC.Store 히스토리안 | 브라우저에서 `https://<서버>:12340/api/v1/read/current?tagIds=<태그>` 응답 확인. `GET /auth-info`로 보안(OAuth) 여부 확인 |
| ② | `opcua` | 모든 dataPARC 서버 (구버전 포함) | `opc.tcp://<서버>:51235/Capstone/OPCUAServer` — UaExpert 등으로 접속 테스트. 인증/인증서는 dataPARC UA Security Console에서 허용 필요 |
| ③ | `parcdata_sql` | PARCdata + SQL CLR 함수 배포 사이트 | SSMS에서 `SELECT TOP 10 * FROM ctc_fn_PARCdata_ReadRawTags('태그', DATEADD(hour,-1,GETDATE()), GETDATE(), 0)` 실행 확인 |
| ④ | `csv_dir` | 자동화 불가 시 수동 운용 | PARCview/Excel 애드인 내보내기 CSV를 `data/` 폴더에 저장 |
| 테스트 | `simulator` | dataPARC 없이 경로 검증 | 기본값 — 바로 실행 가능 |

> 참고: dataPARC 히스토리는 SQL Server에 직접 저장되지 않습니다(파일 기반 아카이브).
> `ctc_config` DB를 직접 쿼리해도 시계열은 나오지 않으니 반드시 위 인터페이스를 쓰세요.
> 관리자에게 요청할 것: 읽기전용 계정/역할(dataPARC Security Console), 서버 TLS 인증서,
> (REST의 경우) OAuth 발급 정보.

### 태그 매핑

웹앱 온톨로지의 태그 ID(예: `FT-101`)와 dataPARC 실제 태그 식별자(예: `Plant.NCC.FT101.PV`)를
`tags:` 섹션에서 짝지어 줍니다. 웹앱의 "자산 온톨로지" 화면에서 태그 목록을 확인할 수 있습니다.

## 3. 실행

```bash
uvicorn main:app --host 0.0.0.0 --port 8137
```

부팅 시 자동 실행(Windows): 작업 스케줄러에 위 명령 등록, 또는 `nssm`으로 서비스화.

## 4. 웹앱 연결

웹앱 → 설정 → 데이터소스 모드 `현장 게이트웨이` → URL `http://<게이트웨이PC IP>:8137` → 연결 테스트.

- 웹앱을 GitHub Pages(https)에서 열는 경우, 브라우저는 `http://localhost`로의 요청만 혼합콘텐츠 예외로 허용합니다.
  다른 PC의 게이트웨이에 붙이려면 ① 웹앱 `index.html`을 로컬 파일/사내 웹서버로 열거나 ② 게이트웨이에 사내 인증서로 HTTPS를 적용하세요.

## 5. API

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/v1/health` | 상태/커넥터/태그 수 |
| GET | `/api/v1/tags` | 태그 목록 |
| GET | `/api/v1/read/raw?tagIds=A,B&start=ISO&end=ISO` | 원시 시계열 `{series: {tag: {t:[ms], v:[]}}}` |
| GET | `/api/v1/read/current?tagIds=A,B` | 현재값 |
