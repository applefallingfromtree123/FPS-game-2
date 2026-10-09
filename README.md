# WARFIELD

브라우저에서 바로 실행되는 대규모 3D FPS. Three.js 클라이언트 + Node.js 권한 서버(WebSocket) 구조이며, Docker로 Oracle Cloud(영구 무료)·Koyeb(무료)·내 PC 등 어디든 올릴 수 있습니다.

## 주요 기능

| 항목 | 내용 |
|---|---|
| 온라인 매치메이킹 | 모드별 로비. **2명 이상 모이면 2분 카운트다운** → 시간이 끝나면 빈 자리를 **AI 봇으로 채워 100명** 매치 시작 (3, 4, 5…명도 동일). 진행 중인 매치가 있으면 봇 한 명과 교체되어 즉시 합류. 혼자일 땐 "봇과 바로 시작" 가능 |
| 게임 모드 (6) | 컨퀘스트(100) · 브레이크스루(100) · **REDSEC 배틀로얄**(100, 4인 분대 25팀, 공중 강하·보급 상자·줄어드는 화염 지대) · 팀 데스매치(48) · 도미네이션(48) · 개인전(32) |
| 전장 (40) | 숲·가을·사막·설원·정글·평원·산악·도시·황무지·사바나 바이옴 × 아침/정오/오후/석양/새벽/흐림/폭풍. 1.6–2.4km 크기(배틀필드급), 마을·도로·호수·해안·섬·협곡이 시드로 결정적 생성 |
| 무기 (112) | 돌격소총 22 · 카빈 10 · 기관단총 16 · 경기관총 12 · 지정사수소총 10 · 저격소총 12 · 산탄총 10 · 권총 14 · 런처 6 (RPG/SMAW/칼 구스타프/재블린/스팅어/M32). 조준경 6종·총구 3종, 사격 모드, 거리별 데미지 감쇠, 헤드샷 |
| 병과 | 돌격병(유탄발사기) · 공병(대전차/대공 런처) · 지원병(보급 상자) · 정찰병(C4, 자동 스팟) |
| 차량 | M1 전차, BMP 장갑차, 전술 차량, 공격 헬기(기관포+로켓), 전투기(기관포+추적 미사일). 파괴·리스폰·자가수리, 봇도 운용 |
| 그래픽 | PBR + 물리 기반 하늘/환경광, 그림자, ACES 톤매핑, 블룸, 컬러 그레이딩, **GPU 잔디(최대 32만 가닥, 바람 애니메이션)**, LOD 나무, 물, 구름, 비/번개, 파티클 폭발·연기·탄흔·예광탄 |
| 캐릭터 | 스킨드 메시 병사(위장 무늬 셰이더, 플레이트 캐리어·헬멧·헤드셋), **IK로 실제 총을 쥐는 팔**, 걷기/질주/앉기/엎드리기/낙하산/사망 애니메이션 |
| AI | 시야각+가시선 인지, 사람 같은 반응 지연, 획득 후 수렴하는 조준 오차, 점사 제어, 엄폐 탐색, 은폐한 적에게 수류탄, 분대 단위 목표 공유·정보 공유, 저격수 고지대 감시, 공병의 대전차 사격, 건물 우회 경로, 끼임 탈출, 모드별 목표 플레이 |
| 네트워크 | 20Hz 서버 틱, 바이너리 스냅샷(플레이어당 24바이트), 보간, **래그 보상 히트 판정**, 서버 권한 데미지 |

## 로컬 실행

```bash
npm install
npm start          # http://localhost:3000
npm test           # 헤드리스로 모든 모드의 100인 봇 매치를 시뮬레이션해 검증
```

## 무료로 서버 올리기

게임 서버는 **웹소켓을 계속 열어 두는 상시 실행 프로세스**라서, Vercel·Netlify 같은 정적/서버리스 호스팅에서는 돌아가지 않습니다. 저장소에 `Dockerfile`이 있어 아래 어디든 같은 방식으로 올라갑니다.

| 방법 | 비용 | 성능 | 특징 |
|---|---|---|---|
| **Oracle Cloud Always Free** (추천) | 영구 무료 (가입 시 카드 인증) | ARM 최대 4코어·24GB | 잠들지 않음. 100인 매치 여러 개도 여유 |
| **Koyeb Free** | 무료 웹서비스 1개 | 0.1 vCPU·512MB | GitHub 연결만 하면 끝. 접속자가 없으면 1시간 뒤 잠들고, 다음 접속 때 몇 초 뒤 깨어남. 매치 1~2개 정도 |
| **내 PC + Cloudflare Tunnel** | 완전 무료, 가입 불필요 | 내 PC 성능 | 친구들과 바로 플레이. PC가 켜져 있는 동안만 접속 가능 |

### A. Oracle Cloud Always Free (상시 운영용)
1. cloud.oracle.com 가입 → **Compute → Create instance** → Image: Ubuntu 22.04/24.04, Shape: `VM.Standard.A1.Flex`(Always Free, 예: 2 OCPU / 12GB)
2. **Networking → VCN → Security List**에 Ingress 규칙 추가: TCP 포트 `80`, Source `0.0.0.0/0`
3. SSH로 접속해서 한 줄 실행:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/<계정>/<저장소>/<브랜치>/deploy/oracle-setup.sh | bash -s -- https://github.com/<계정>/<저장소>.git <브랜치>
   ```
4. `http://<VM 공인 IP>/` 접속. 서버는 재부팅해도 자동으로 다시 켜집니다.

### B. Koyeb Free (가장 간단)
1. koyeb.com 가입 → **Create Web Service → GitHub** → 이 저장소·브랜치 선택
2. Builder: **Dockerfile**, Instance: **Free**, Region: Frankfurt 또는 Washington
3. Port `8000`(HTTP), Health check `/health` → Deploy
4. `https://<앱이름>.koyeb.app` 접속 (설정 요약: `deploy/koyeb.yaml`)

### C. 내 PC에서 띄우고 친구 초대
```bash
npm install
npm start                                   # http://localhost:3000
cloudflared tunnel --url http://localhost:3000   # 출력된 https://xxxx.trycloudflare.com 주소를 친구에게 공유
```
`cloudflared`는 Cloudflare 공식 무료 도구입니다(Windows: `winget install Cloudflare.cloudflared`, macOS: `brew install cloudflared`). 계정이 필요 없고 웹소켓도 그대로 통과합니다.

### Docker 직접 실행 (Fly.io, Google Cloud Run, 다른 VPS 등)
```bash
docker build -t warfield .
docker run -d -p 80:8000 --restart unless-stopped warfield
```
서버는 `PORT` 환경변수를 따릅니다(컨테이너 기본값 8000). Render를 계속 쓰고 싶다면 `render.yaml`도 그대로 남아 있습니다.

> 서버 부하: 100인 매치(봇 포함) 1개가 CPU 1코어 기준 20Hz 틱당 약 0.3–1ms입니다.

## 조작법

WASD 이동 · Shift 질주 · Space 점프/낙하산 · C 앉기 · Z 엎드리기 · 좌클릭 사격 · 우클릭 조준 · R 재장전 · B 사격 모드 · 1/2/3 무기 · G 수류탄 · Q 스팟 · E 탑승/하차/보급상자 · V 차량 시점 · Tab 점수판 · M 지도 · Esc 메뉴

## 구조

```
shared/   서버·클라이언트 공용: 무기 DB, 맵 정의, 모드, 결정적 월드 생성/충돌/레이캐스트, 바이너리 프로토콜
server/   index.js(HTTP+WS) · matchmaker.js(로비/2분 타이머/봇 충원) · match.js(시뮬레이션·모드 규칙·래그 보상) · bot.js(보병 AI) · vehicleAI.js(차량 AI)
client/   game.js(렌더링·플레이어·무기·보간) · env.js(지형·잔디·나무·건물·물·하늘) · soldier.js · guns.js · vehicles.js · fx.js · hud.js · audio.js · main.js(UI)
```

설정 변경: 모드별 인원/티켓은 `shared/modes.js`, 대기 시간은 `LOBBY_WAIT_SECONDS`, 그래픽 프리셋은 `client/js/env.js`의 `QUALITY`.

## 한계 (솔직하게)

외부 아트 에셋 없이 모든 모델·텍스처·사운드를 코드로 생성합니다. 그래서 조명·잔디·그림자·후처리는 현대적이지만, 캐릭터와 총기는 모션캡처와 스캔 에셋을 쓰는 AAA 게임 수준의 사실감에는 미치지 못합니다. 실제 AAA 품질을 원하면 glTF 캐릭터/무기 모델과 애니메이션을 `client/js/soldier.js`, `guns.js`에 교체 연결하는 방식으로 확장할 수 있습니다. 건물 내부 진입, 차량 동승석, 부상자 소생은 아직 없습니다.
