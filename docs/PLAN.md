# MEDI PdM — 설비 예지보전 시스템 설계 문서

> 석유화학 공장 · dataPARC 연동 · **룰베이스 우선, AI는 선택 확장**

## 0. 문제 정의

- 현장 계기/전기/센서 신호는 dataPARC를 거쳐 PC에서 볼 수 있지만, **정비부서는 이상 신호를 생산팀이 말해주기 전엔 모른다.**
- 단일 태그 임계값 알람은 늦거나(이미 고장) 부하 변동에 오작동한다.
- 필요한 것: **여러 신호를 복합적으로 + 통계적으로** 분석해 열화를 조기에 잡고, 근거·권고조치와 함께 정비부서에 알려주는 도구.

## 1. 아키텍처

```
[현장 계기/DCS/전기설비]
        │
   [dataPARC]  PARCserver / dataPARC.Store 히스토리안
        │
        ├──(①REST ②OPC UA ③PARCdata SQL ④CSV)──┐
        │                                        │
   [게이트웨이 backend/ FastAPI]  ← 공장 PC에서 실행, 통일된 REST 제공
        │
   [웹앱 index.html]  ← 브라우저만 있으면 동작 (GitHub Pages/로컬 파일/사내 웹서버)
        ├─ 데이터소스: 데모 시뮬레이터 │ 게이트웨이 │ CSV 업로드
        ├─ 분석엔진(JS, 의존성 0): SPC·PCA·고장모드 매칭·5대 패턴
        ├─ 자산 온톨로지(ISO 14224/ISA-95/ISA-5.1)
        ├─ 알람 엔진(ISA-18.2 합리화)
        ├─ 룰베이스 진단 리포트(기본)
        └─ LLM 분석(선택 · API 키 입력 시 활성화)
```

설계 원칙
1. **오프라인 우선**: 웹앱은 빌드/CDN/서버 없이 `index.html` 더블클릭으로도 동작 (공장 내부망 PC 고려).
2. **룰베이스 완결**: API 키·인터넷 없이 모든 진단이 성립. AI는 "있으면 더 좋은" 계층.
3. **온톨로지 중심**: 자산·태그·고장모드 지식을 JSON 하나로 관리 → 룰베이스 근거이자 미래 LLM 컨텍스트.

## 2. dataPARC 연동 (조사 검증 결과)

dataPARC(Capstone Technology)가 공식 제공하는 외부 접근 수단과 권장 순위:

| 순위 | 방식 | 내용 | 비고 |
|---|---|---|---|
| ① | **dataPARC.Store REST API** | `GET /api/v1/read/raw·aggregate·at-time·current?tagIds=&start=&end=` | 신형 히스토리안. HTTPS 전용, OpenAPI 공개(github.com/dataPARC/store). 보안 활성 시 OAuth Bearer(`GET /auth-info`로 확인). 서버측 집계(TimeAverage 등 ~23종) 지원 → 대량 조회에 유리 |
| ② | **gRPC / .NET SDK** | `StreamRawData`, `ReadCurrentValues` 등 | 공식 Python 예제 존재. 대량 백필/스트리밍용. SDK NuGet은 벤더 피드 필요 |
| ③ | **OPC UA** | `opc.tcp://서버:51235/Capstone/OPCUAServer` | **모든 dataPARC 서버에 존재(구버전 포함)** — 가장 범용적 폴백. Anonymous/Username 인증, UA Security Console에서 허용 필요. 대량 히스토리 읽기는 성능 저하 가능 |
| ④ | **PARCdata SQL** | `SELECT * FROM ctc_fn_PARCdata_ReadRawTags('t1,t2',@s,@e,0)` | SQL Server CLR 함수. PARCdata 배포 사이트 한정(레거시) |
| ⑤ | **Excel/CSV 내보내기** | PARCview·Excel 애드인 | 수동. 검증/실습용 |

> ⚠ 히스토리는 SQL Server에 저장되지 않음(파일 기반 아카이브). `ctc_config` DB 직쿼리는 설정/이벤트만 나온다.

**현장 첫 단계 체크리스트**
1. `https://<서버>:12340/auth-info` 와 `/api/v1/read/current?tagIds=…` 응답 확인 (신형 여부)
2. UaExpert로 `opc.tcp://<서버>:51235/Capstone/OPCUAServer` 접속 확인 (폴백)
3. dataPARC 관리자에게: 읽기전용 역할(Security Console), TLS 인증서, (REST면) OAuth 정보 요청
4. `backend/config.yaml`에 커넥터+태그 매핑 작성 → 게이트웨이 기동 → 웹앱 연결 테스트

## 3. 분석 로직 (룰베이스 엔진)

### 3.1 단변량 SPC — `js/analytics/stats.js`
| 기법 | 용도 | 파라미터 |
|---|---|---|
| EWMA 관리도 | 소폭·지속 이동(서서한 열화) 조기 검출 | λ=0.2(빠름)/0.05(파울링류), L=3 |
| CUSUM(표형식) | 1σ급 평균이동 최속 검출 | k=0.5, h=5 |
| Western Electric/Nelson 런규칙 | 3σ 스파이크, 연속 상승 6점 등 패턴 | R1·R2·R3·R4·R5 |
| 강건 통계 | 이상치에 안전한 베이스라인 | MAD×1.4826 |
| 지속성/데드밴드 | 채터링 억제 | m-of-n, 히스테리시스 |

### 3.2 다변량 — `js/analytics/multivariate.js` (복합 신호 분석의 핵심)
- **PCA + Hotelling T²**: 정상운전 학습 → 운전점이 정상영역을 벗어나는지.
- **SPE/Q**: 신호 간 **상관구조 붕괴** 검출 — *개별 태그가 전부 정상범위여도* 관계가 깨지면 경보. 관리한계는 Jackson–Mudholkar + 경험적 분위수 중 보수적인 값.
- **기여도 분해**: 알람 시 어느 태그가 원인인지 상위 기여 태그 지목.
- **Mahalanobis 거리**: 설비 전체 신호를 한 점수로 — 건강지수의 근간.

### 3.3 설비별 물리 파생지표 — `js/analytics/equipment.js`
| 설비 | 지표 | 잡는 고장 |
|---|---|---|
| 원심펌프 | 효율 프록시 Q·ΔP/I, 흡입압·토출압 변동성 | 임펠러 마모, 캐비테이션 |
| 압축기 | 서지마진(유량 기준), 압축비 보정 토출온도 | 서지 접근, 내부 오염 |
| 열교환기 | U값 프록시 Q/LMTD, 접근온도차, ΔP | 파울링, 튜브 누설 |
| 모터 | 전류-부하 잔차, 권선온도 추세 | 과부하, 절연 열화 |

### 3.4 고장모드 매칭 — `js/ontology.js`
ISO 14224 고장모드 라이브러리(증상 시그니처: `역할태그 × 패턴(상승/하강/변동성/스파이크) × 가중치`)에
관측 증상을 대조해 **일치도 점수 + 감별 포인트(미관측 증상) + 권고 조치**를 산출.

### 3.5 건강지수·알람 — `js/analytics/health.js`
- 건강지수 0–100: 다변량 위반율 + 고장모드 일치도 + 설계한계 접근의 가중 감점.
- 알람(ISA-18.2): m-of-n 지속성, 오프딜레이, **first-out 그룹핑**(고장모드 알람 활성 시 하위 추세/다변량 알람 억제 → 원인 1건=알람 1건), 우선순위 4단계, 근거/권고 첨부.

### 3.6 5대 분석 패턴 실습 — `js/analytics/patterns.js`
회귀(관계 잔차 감시) · 분류(룰 트리 상태 라벨링) · 군집(k-means 운전모드) ·
이상탐지(Mahalanobis) · 시계열(Holt 예측 + 한계도달 시점 = 잔여수명 근사).
→ "분석 실습" 메뉴에서 내 업무 데이터(CSV)로 바로 실행 가능.

## 4. 자산 온톨로지

- 구조: ISA-95 계층(사이트→구역→유닛→설비) + ISO 14224 설비클래스/고장모드 + ISA-5.1 태그 자동분류(PT/TT/FT/PDT/VT/IT…).
- 목적: ① 룰베이스 진단의 지식 근거 ② 태그 자동 해석 ③ **LLM 컨텍스트 직렬화**(`toLLMContext`) — 문헌상 LLM은 설비 지식을 자체 보유하지 못하므로, 컴팩트한 "자산 카드" JSON을 통째로 주는 방식이 정확도가 가장 높음.
- 편집: 화면에서 JSON 내보내기/가져오기 → 실제 공장 자산으로 교체.

## 5. LLM 분석 (추후 — 현재 비활성)

- 키가 없으면 완전 비활성. **룰베이스 리포트가 기본 경로.**
- 키 입력 시(설정): 브라우저에서 Anthropic Messages API 직접 호출(BYOK).
  - `POST https://api.anthropic.com/v1/messages`, 헤더 `anthropic-version: 2023-06-01`, `anthropic-dangerous-direct-browser-access: true`
  - 기본 모델 `claude-opus-4-8`(권장), 스트리밍 SSE.
  - 컨텍스트 = 온톨로지 자산카드 + 관측 증상 + 통계 스냅샷 → 감별진단/정비계획 질의.
- 키 보관: 기본 메모리(새로고침 시 삭제), localStorage 저장은 명시적 옵트인.

## 6. 배포·운용

| 시나리오 | 방법 |
|---|---|
| 데모/학습 | GitHub Pages URL 접속 (main 병합 시 자동 배포) 또는 `index.html` 더블클릭 |
| 현장 PoC | dataPARC CSV 내보내기 → 웹앱 CSV 업로드 |
| 현장 상시 | 공장 PC에 게이트웨이 상주(backend/) + 웹앱을 로컬/사내 웹서버로 |

## 7. 로드맵

- **Phase 1 (완료)** 룰베이스 엔진 + 데모 시뮬레이터 + 5패턴 실습 + 게이트웨이 골격
- **Phase 2 (현장 적용)** 실제 태그 매핑, 커넥터 확정(REST→UA 폴백), 온톨로지를 실제 자산으로 교체, 임계·베이스라인 캘리브레이션, 정상운전 구간 지정 UI
- **Phase 3 (고도화)** LLM 분석 활성화(API 키), 알람 이력 DB화, 운전모드별 다변량 모델 분리(군집 활용), 정비이력 연계(고장모드 사후 검증), 이메일/메신저 알림
