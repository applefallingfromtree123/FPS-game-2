# Northflank 배포 (WARFIELD)

1. northflank.com 가입 → **Create project** (리전: 가까운 곳, 예: Europe/US)
2. 프로젝트 안에서 **Add new service → Combined service** (빌드 + 배포)
3. **Repository**: GitHub 연결 후 이 저장소, 브랜치 `claude/warfield-fps` 선택
4. **Build**: *Dockerfile* 선택 (Build context `/`, Dockerfile 경로 `/Dockerfile`)
5. **Networking → Add port**
   - Port: `8000`, Protocol: `HTTP`, **Publicly expose: on**
   - (웹소켓은 HTTP 포트에서 자동으로 업그레이드되어 그대로 동작합니다)
6. **Health checks**: HTTP, path `/health`, port `8000`
7. **Resources**: 무료(sandbox) 플랜 중 가장 큰 크기 선택
8. **Create service** → 빌드가 끝나면 `https://<서비스>--<프로젝트>--<id>.code.run` 형태의 주소로 접속

환경변수는 필요 없습니다(`PORT`는 Dockerfile에서 8000으로 고정).
