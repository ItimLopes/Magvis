/* ============================================================
   SIMULAÇÃO — VENTOS SOLARES, MAGNETOSFERA & SATÉLITE
   Three.js r128

   ANIMAÇÃO DE LINHAS:
   Usa ShaderMaterial com uniform "uOffset" incrementado a cada
   frame. O shader calcula frac(lineDistance + uOffset) e descarta
   fragmentos na "zona gap", criando pontilhado que realmente
   flui pela linha — funciona em r128 sem extensões extras.

   DEFLEXÃO DO VENTO:
   As linhas de vento são reconstruídas a cada mudança de nível;
   a curvatura ao redor da magnetopausa comprimida é visível
   nas próprias linhas estáticas + no fluxo animado ao longo delas.
   ============================================================ */
(function () {
  'use strict';

  /* ─────────────────────────────────────────────────────────
     STORM DATA
  ───────────────────────────────────────────────────────── */
  const STORM_DATA = [
    { badge:'G0', kp:'Kp: 0–4', name:'Atividade solar mínima',
      speed:'350 km/s', density:'3 p/cm³', bfield:'–2 nT',
      aurora:'Ausente', risk:'Nenhum', riskClass:'',
      desc:'Vento solar em nível basal. Magnetosfera estável. Nenhum risco a satélites ou infraestrutura.',
      windSpeed:0.4, particleCount:200, compressionFactor:1.00,
      auroraIntensity:0.00, satRisk:0.00 },
    { badge:'G1', kp:'Kp: 5–6', name:'Tempestade menor',
      speed:'400 km/s', density:'5 p/cm³', bfield:'–5 nT',
      aurora:'65°–70° lat', risk:'Baixo', riskClass:'low',
      desc:'Perturbação leve. Auroras visíveis em altas latitudes. Pequenas flutuações em redes elétricas.',
      windSpeed:0.7, particleCount:350, compressionFactor:0.92,
      auroraIntensity:0.22, satRisk:0.08 },
    { badge:'G2', kp:'Kp: 6–7', name:'Tempestade moderada',
      speed:'550 km/s', density:'9 p/cm³', bfield:'–12 nT',
      aurora:'55°–65° lat', risk:'Moderado', riskClass:'moderate',
      desc:'Auroras em latitudes médias. Interrupções HF possíveis. Satélites LEO com arrasto aumentado.',
      windSpeed:1.1, particleCount:550, compressionFactor:0.82,
      auroraIntensity:0.45, satRisk:0.30 },
    { badge:'G3', kp:'Kp: 7–8', name:'Tempestade forte',
      speed:'750 km/s', density:'15 p/cm³', bfield:'–25 nT',
      aurora:'50°–55° lat', risk:'Alto', riskClass:'high',
      desc:'Auroras até latitudes temperadas. Risco a satélites GPS. Correntes em oleodutos e linhas de transmissão.',
      windSpeed:1.6, particleCount:800, compressionFactor:0.70,
      auroraIntensity:0.68, satRisk:0.60 },
    { badge:'G4', kp:'Kp: 8–9', name:'Tempestade severa',
      speed:'950 km/s', density:'22 p/cm³', bfield:'–45 nT',
      aurora:'45°–50° lat', risk:'Crítico', riskClass:'critical',
      desc:'Auroras em baixas latitudes. Falhas GPS e radiocomunicação. Possível perda de controle de satélites.',
      windSpeed:2.3, particleCount:1200, compressionFactor:0.57,
      auroraIntensity:0.86, satRisk:0.85 },
    { badge:'G5', kp:'Kp: 9', name:'Tempestade extrema',
      speed:'1200 km/s', density:'35 p/cm³', bfield:'–70 nT',
      aurora:'< 40° lat', risk:'Extremo', riskClass:'extreme',
      desc:'Nível mais severo. Blackouts extensos, perda de satélites, falha total de GPS. Evento tipo Carrington (1859).',
      windSpeed:3.0, particleCount:1800, compressionFactor:0.42,
      auroraIntensity:1.00, satRisk:1.00 },
  ];

  const LEVEL_COLORS = [0xaab8d4,0x5fa8ff,0x38d48a,0xf0c040,0xf07030,0xe03030];
  const SUN_X   = -65;
  const SAT_R   = 4.8;
  const SAT_INC = 0.3;

  /* ─────────────────────────────────────────────────────────
     SHADERS — pontilhado animado via lineDistance + uOffset
     Cada vértice precisa de um atributo "lineDistance" (acumulado
     ao longo da linha). O fragment shader usa frac para criar
     o padrão dash/gap e uOffset para mover o fluxo.
  ───────────────────────────────────────────────────────── */
  const VERT_SHADER = /* glsl */`
    attribute float lineDistance;
    varying float vLineDistance;
    void main() {
      vLineDistance = lineDistance;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;

  // dashRatio: fração [0..1] do período que é "dash" (resto é gap)
  const FRAG_SHADER = /* glsl */`
    uniform vec3  uColor;
    uniform float uOpacity;
    uniform float uOffset;     // incrementado todo frame
    uniform float uPeriod;     // comprimento total do padrão (dash+gap)
    uniform float uDashRatio;  // fração que é dash

    varying float vLineDistance;

    void main() {
      float t = mod(vLineDistance + uOffset, uPeriod) / uPeriod;
      if (t > uDashRatio) discard;   // descarta o gap
      gl_FragColor = vec4(uColor, uOpacity);
    }
  `;

  /* ─────────────────────────────────────────────────────────
     STATE
  ───────────────────────────────────────────────────────── */
  let currentLevel = 0;
  let simSpeed  = 1.0, paused = false;
  let showFieldLines = false, showWindLines = false;
  let showVanAllen   = false, showSatellite = true;
  let satAngle = 0, globalTime = 0;

  let renderer, scene, camera, clock;
  let earth, earthAtmo;
  let auroraNorth, auroraSouth;
  let fieldLineGroup, magnetosheath;
  let innerBelt, outerBelt;
  let windParticles, windPositions, windVelocities;
  let windLineGroup, satOrbitLine;
  let sunMesh, sunGlow, sunLight, stormLight;
  let satelliteGroup, satWarningLight;

  // coleta de uniforms para animar a cada frame
  let fieldUniforms = [];   // uniform objects das linhas de campo
  let windUniforms  = [];   // uniform objects das linhas de vento

  /* ─────────────────────────────────────────────────────────
     ORBIT CONTROLS (manual — sem módulo extra)
  ───────────────────────────────────────────────────────── */
  const orbit = {
    s:{ theta:-0.3, phi:1.1, radius:22 },
    target: new THREE.Vector3(),
    drag:false, rDrag:false, lx:0, ly:0,
    minR:5, maxR:120,
  };

  function orbitApply() {
    const {s, target} = orbit;
    s.phi = Math.max(0.05, Math.min(Math.PI - 0.05, s.phi));
    const sp = Math.sin(s.phi);
    camera.position.set(
      target.x + s.radius * sp * Math.sin(s.theta),
      target.y + s.radius * Math.cos(s.phi),
      target.z + s.radius * sp * Math.cos(s.theta)
    );
    camera.lookAt(target);
  }

  function setupOrbit() {
    const cv = renderer.domElement;
    cv.addEventListener('mousedown', e => {
      if (e.target !== cv) return;
      orbit.drag = true; orbit.rDrag = e.button === 2;
      orbit.lx = e.clientX; orbit.ly = e.clientY;
    });
    window.addEventListener('mousemove', e => {
      if (!orbit.drag) return;
      const dx = e.clientX - orbit.lx, dy = e.clientY - orbit.ly;
      orbit.lx = e.clientX; orbit.ly = e.clientY;
      if (orbit.rDrag) {
        const sp = orbit.s.radius * 0.0012;
        const r  = new THREE.Vector3();
        r.crossVectors(camera.getWorldDirection(new THREE.Vector3()), camera.up).normalize();
        orbit.target.addScaledVector(r, -dx * sp);
        orbit.target.addScaledVector(camera.up, dy * sp);
      } else {
        orbit.s.theta -= dx * 0.006;
        orbit.s.phi   -= dy * 0.006;
      }
      orbitApply();
    });
    window.addEventListener('mouseup',    () => { orbit.drag = false; });
    window.addEventListener('mouseleave', () => { orbit.drag = false; });
    cv.addEventListener('wheel', e => {
      e.preventDefault();
      orbit.s.radius *= 1 + e.deltaY * 0.001;
      orbit.s.radius = Math.max(orbit.minR, Math.min(orbit.maxR, orbit.s.radius));
      orbitApply();
    }, { passive: false });
    cv.addEventListener('contextmenu', e => e.preventDefault());

    let ltd = 0;
    cv.addEventListener('touchstart', e => {
      if (e.touches.length === 1) {
        orbit.drag = true; orbit.rDrag = false;
        orbit.lx = e.touches[0].clientX; orbit.ly = e.touches[0].clientY;
      } else if (e.touches.length === 2) {
        orbit.drag = false;
        ltd = Math.hypot(e.touches[0].clientX - e.touches[1].clientX,
                         e.touches[0].clientY - e.touches[1].clientY);
      }
    });
    cv.addEventListener('touchmove', e => {
      e.preventDefault();
      if (e.touches.length === 1 && orbit.drag) {
        const dx = e.touches[0].clientX - orbit.lx, dy = e.touches[0].clientY - orbit.ly;
        orbit.lx = e.touches[0].clientX; orbit.ly = e.touches[0].clientY;
        orbit.s.theta -= dx * 0.006; orbit.s.phi -= dy * 0.006; orbitApply();
      } else if (e.touches.length === 2) {
        const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX,
                             e.touches[0].clientY - e.touches[1].clientY);
        orbit.s.radius *= ltd / d;
        orbit.s.radius = Math.max(orbit.minR, Math.min(orbit.maxR, orbit.s.radius));
        ltd = d; orbitApply();
      }
    }, { passive: false });
    cv.addEventListener('touchend', () => { orbit.drag = false; });
  }

  /* ─────────────────────────────────────────────────────────
     HELPER — constrói geometria de linha com atributo lineDistance
     Necessário para o shader calcular o padrão corretamente.
  ───────────────────────────────────────────────────────── */
  function buildLineGeometry(points) {
    const positions = [];
    const distances = [];
    let acc = 0;
    for (let i = 0; i < points.length; i++) {
      positions.push(points[i].x, points[i].y, points[i].z);
      if (i === 0) {
        distances.push(0);
      } else {
        acc += points[i].distanceTo(points[i - 1]);
        distances.push(acc);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position',     new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('lineDistance', new THREE.Float32BufferAttribute(distances, 1));
    return geo;
  }

  /* ─────────────────────────────────────────────────────────
     HELPER — cria linha com ShaderMaterial animável
     Retorna { line, uniforms } — uniforms.uOffset.value é
     incrementado no loop de animação.
  ───────────────────────────────────────────────────────── */
  function makeFlowLine(points, colorHex, opacity, period, dashRatio) {
    const geo = buildLineGeometry(points);
    const col = new THREE.Color(colorHex);
    const uniforms = {
      uColor:     { value: new THREE.Vector3(col.r, col.g, col.b) },
      uOpacity:   { value: opacity },
      uOffset:    { value: 0.0 },
      uPeriod:    { value: period },
      uDashRatio: { value: dashRatio },
    };
    const mat = new THREE.ShaderMaterial({
      vertexShader:   VERT_SHADER,
      fragmentShader: FRAG_SHADER,
      uniforms,
      transparent:  true,
      depthWrite:   false,
      blending:     THREE.AdditiveBlending,
    });
    const line = new THREE.Line(geo, mat);
    return { line, uniforms };
  }

  /* ─────────────────────────────────────────────────────────
     TEXTURA PROCEDURAL DE AURORA
  ───────────────────────────────────────────────────────── */
  function makeAuroraTexture() {
    const size = 512;
    const cv   = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, size, size);
    const cx = size / 2, cy = size / 2;
    const rOut = size * 0.46, rIn = size * 0.28;

    const bands = [
      { r0: rOut * 0.60, r1: rOut * 0.78, col: ['rgba(0,255,100,0)',   'rgba(0,255,120,0.55)', 'rgba(0,255,100,0)']   },
      { r0: rOut * 0.70, r1: rOut * 0.90, col: ['rgba(100,255,180,0)', 'rgba(80,220,255,0.30)', 'rgba(100,255,180,0)'] },
      { r0: rOut * 0.78, r1: rOut * 1.00, col: ['rgba(160,80,255,0)',  'rgba(180,60,255,0.20)', 'rgba(160,80,255,0)']  },
    ];
    for (let a = 0; a < Math.PI * 2; a += 0.018) {
      for (const b of bands) {
        const x1 = cx + Math.cos(a) * b.r0, y1 = cy + Math.sin(a) * b.r0;
        const x2 = cx + Math.cos(a) * b.r1, y2 = cy + Math.sin(a) * b.r1;
        const g = ctx.createLinearGradient(x1, y1, x2, y2);
        g.addColorStop(0, b.col[0]); g.addColorStop(0.5, b.col[1]); g.addColorStop(1, b.col[2]);
        ctx.strokeStyle = g; ctx.lineWidth = 8;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      }
    }
    for (let i = 0; i < 80; i++) {
      const a = (i / 80) * Math.PI * 2 + (Math.random() - 0.5) * 0.3;
      const r0 = rIn + Math.random() * rOut * 0.22;
      const r1 = rOut * (0.80 + Math.random() * 0.22);
      ctx.strokeStyle = Math.random() > 0.5
        ? `rgba(60,255,140,${0.10 + Math.random() * 0.28})`
        : `rgba(120,200,255,${0.08 + Math.random() * 0.20})`;
      ctx.lineWidth = 1.5 + Math.random() * 3;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.stroke();
    }
    return new THREE.CanvasTexture(cv);
  }

  /* ─────────────────────────────────────────────────────────
     INIT
  ───────────────────────────────────────────────────────── */
  function init() {
    const canvas = document.getElementById('canvas');
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.9;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x020510);
    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 2000);
    orbitApply();
    clock = new THREE.Clock();

    buildStarField();
    buildSun();
    buildLights();
    buildEarth();
    buildMagnetosphere();
    buildVanAllenBelts();
    buildAuroras();
    buildWindParticles();
    buildWindLines();
    buildSatOrbitLine();
    buildSatellite();

    setupOrbit();
    setupUI();
    applyStormLevel(currentLevel);

    // Sincroniza visibilidade inicial com os estados padrão
    fieldLineGroup.visible  = showFieldLines;   // false
    windLineGroup.visible   = showWindLines;    // false
    windParticles.visible   = showWindLines;    // false (partículas também)
    innerBelt.visible       = showVanAllen;     // false
    outerBelt.visible       = showVanAllen;     // false
    satelliteGroup.visible  = showSatellite;    // true
    satOrbitLine.visible    = showSatellite;    // true

    window.addEventListener('resize', onResize);
    animate();
  }

  /* ─────────────────────────────────────────────────────────
     ESTRELAS
  ───────────────────────────────────────────────────────── */
  function buildStarField() {
    const N = 7000;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const r  = 700 + Math.random() * 500;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      pos[i*3]   = r * Math.sin(ph) * Math.cos(th);
      pos[i*3+1] = r * Math.sin(ph) * Math.sin(th);
      pos[i*3+2] = r * Math.cos(ph);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    scene.add(new THREE.Points(geo,
      new THREE.PointsMaterial({ color:0xffffff, size:0.55, sizeAttenuation:true, transparent:true, opacity:0.75 })));
  }

  /* ─────────────────────────────────────────────────────────
     SOL
  ───────────────────────────────────────────────────────── */
  function buildSun() {
    const R = 7.0;
    const loader = new THREE.TextureLoader();
    const tex = loader.load('assets/sun_surface.jpg', undefined, undefined, () => {});
    sunMesh = new THREE.Mesh(
      new THREE.SphereGeometry(R, 48, 48),
      new THREE.MeshBasicMaterial({ map: tex, color: 0xffdd88 })
    );
    sunMesh.position.set(SUN_X, 0, 0);
    scene.add(sunMesh);

    sunGlow = new THREE.Mesh(
      new THREE.SphereGeometry(R * 1.6, 32, 32),
      new THREE.MeshBasicMaterial({ color:0xff8800, transparent:true, opacity:0.09, side:THREE.BackSide, depthWrite:false })
    );
    sunGlow.position.copy(sunMesh.position);
    scene.add(sunGlow);

    const g2 = new THREE.Mesh(
      new THREE.SphereGeometry(R * 2.3, 32, 32),
      new THREE.MeshBasicMaterial({ color:0xff5500, transparent:true, opacity:0.04, side:THREE.BackSide, depthWrite:false })
    );
    g2.position.copy(sunMesh.position);
    scene.add(g2);
  }

  /* ─────────────────────────────────────────────────────────
     LUZES
  ───────────────────────────────────────────────────────── */
  function buildLights() {
    scene.add(new THREE.AmbientLight(0x111133, 0.5));
    sunLight = new THREE.DirectionalLight(0xfff0cc, 2.2);
    sunLight.position.set(SUN_X, 0, 0);
    scene.add(sunLight);
    stormLight = new THREE.PointLight(0x4488ff, 0, 10);
    stormLight.position.set(0, 0, 0);
    scene.add(stormLight);
  }

  /* ─────────────────────────────────────────────────────────
     TERRA
  ───────────────────────────────────────────────────────── */
  function buildEarth() {
    const R = 2.5;
    const loader = new THREE.TextureLoader();
    const tex = loader.load('assets/earth_day.jpg', undefined, undefined, () => {});
    earth = new THREE.Mesh(
      new THREE.SphereGeometry(R, 64, 64),
      new THREE.MeshPhongMaterial({ map:tex, color:0x1a6688, specular:new THREE.Color(0x222244), shininess:18 })
    );
    earth.rotation.z = THREE.MathUtils.degToRad(23.5);
    scene.add(earth);

    earthAtmo = new THREE.Mesh(
      new THREE.SphereGeometry(R * 1.04, 64, 64),
      new THREE.MeshPhongMaterial({ color:0x3388ff, transparent:true, opacity:0.12, side:THREE.FrontSide, depthWrite:false })
    );
    scene.add(earthAtmo);
  }

  /* ─────────────────────────────────────────────────────────
     MAGNETOSFERA
     Linhas verdes (#00dd44) de polo sul → polo norte
     Fluxo animado via uOffset no ShaderMaterial
  ───────────────────────────────────────────────────────── */
  function buildMagnetosphere() {
    fieldLineGroup = new THREE.Group();
    scene.add(fieldLineGroup);
    drawFieldLines();

    magnetosheath = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 32),
      new THREE.MeshPhongMaterial({ color:0x002211, transparent:true, opacity:0.06, side:THREE.BackSide, depthWrite:false })
    );
    magnetosheath.scale.set(14, 9, 9);
    scene.add(magnetosheath);
  }

  function drawFieldLines() {
    // dispõe linhas antigas e limpa lista de uniforms
    fieldLineGroup.children.forEach(c => { if (c.material) c.material.dispose(); });
    fieldLineGroup.clear();
    fieldUniforms = [];

    const cf   = STORM_DATA[currentLevel].compressionFactor;
    const lats = [15, 30, 45, 60, 75];
    const R    = 2.5;

    lats.forEach((latDeg, li) => {
      const nPhi = 12;
      for (let i = 0; i < nPhi; i++) {
        const phi = (i / nPhi) * Math.PI * 2;
        const pts = [];

        // dipolo completo: t=0 (polo sul) → t=π (polo norte)
        for (let s = 0; s <= 120; s++) {
          const t = (s / 120) * Math.PI;
          const L = 1.2 + (latDeg / 90) * 5.5;  // L-shell
          const r = L * R * Math.sin(t) * Math.sin(t);
          if (r < R * 0.95) continue;

          const sinLat = Math.cos(t);
          const cosLat = Math.sqrt(Math.max(0, 1 - sinLat * sinLat));
          let x = r * cosLat * Math.cos(phi);
          const y = r * sinLat;
          const z = r * cosLat * Math.sin(phi);

          // compressão no lado do Sol (x < 0 é lado solar com SUN_X negativo)
          if (x < 0) x *= cf + (1 - cf) * Math.abs(x) / (r + 0.001);

          pts.push(new THREE.Vector3(x, y, z));
        }
        if (pts.length < 2) continue;

        const opacity = 0.30 + (latDeg / 90) * 0.28;
        // period: comprimento visual do padrão dash+gap em unidades de mundo
        const period    = 0.55 + li * 0.06;
        const dashRatio = 0.55;   // 55% dash, 45% gap

        const { line, uniforms } = makeFlowLine(pts, 0x00dd44, opacity, period, dashRatio);
        fieldLineGroup.add(line);
        fieldUniforms.push(uniforms);
      }
    });

    fieldLineGroup.visible = showFieldLines;
  }

  /* ─────────────────────────────────────────────────────────
     VAN ALLEN BELTS
  ───────────────────────────────────────────────────────── */
  function buildVanAllenBelts() {
    innerBelt = makeBelt(4.2, 0.65, 0xffaa44, 0.20);
    outerBelt = makeBelt(7.5, 1.60, 0x44aaff, 0.14);
    scene.add(innerBelt);
    scene.add(outerBelt);
  }

  function makeBelt(r, tube, color, opacity) {
    const mat = new THREE.MeshPhongMaterial({
      color, transparent:true, opacity, side:THREE.DoubleSide,
      depthWrite:false, emissive:color, emissiveIntensity:0.4,
    });
    const mesh = new THREE.Mesh(new THREE.TorusGeometry(r, tube, 20, 120), mat);
    mesh.rotation.x = Math.PI / 2;
    return mesh;
  }

  /* ─────────────────────────────────────────────────────────
     AURORAS — calota esférica com textura
  ───────────────────────────────────────────────────────── */
  function buildAuroras() {
    const R        = 2.56;
    const capAngle = Math.PI * 0.38;
    const loader   = new THREE.TextureLoader();

    // cria procedural, carrega a textura real em seguida (substitui)
    const tex = makeAuroraTexture(); // procedural imediato
    loader.load('assets/aurora_texture.png', (loaded) => {
      tex.image = loaded.image;
      tex.needsUpdate = true;
});

    const mkMat = () => new THREE.MeshBasicMaterial({
      map: tex, transparent: true, opacity: 0,
      side: THREE.FrontSide, depthWrite: false, blending: THREE.AdditiveBlending,
    });

    auroraNorth = new THREE.Mesh(new THREE.SphereGeometry(R, 64, 32, 0, Math.PI*2, 0, capAngle), mkMat());
    auroraSouth = new THREE.Mesh(new THREE.SphereGeometry(R, 64, 32, 0, Math.PI*2, Math.PI - capAngle, capAngle), mkMat());
    auroraSouth.rotation.x = Math.PI;

    earth.add(auroraNorth);
    earth.add(auroraSouth);
  }

  /* ─────────────────────────────────────────────────────────
     PARTÍCULAS DE VENTO SOLAR
  ───────────────────────────────────────────────────────── */
  function buildWindParticles() {
    const MAX = 2000;
    windPositions  = new Float32Array(MAX * 3);
    windVelocities = new Float32Array(MAX * 3);
    for (let i = 0; i < MAX; i++) resetParticle(i);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(windPositions, 3));
    windParticles = new THREE.Points(geo,
      new THREE.PointsMaterial({ color:0xff8833, size:0.10, transparent:true, opacity:0.75, sizeAttenuation:true, depthWrite:false })
    );
    scene.add(windParticles);
  }

  function resetParticle(i) {
    const spread = 18;
    windPositions[i*3]   = SUN_X + 8 + Math.random() * 3;
    windPositions[i*3+1] = (Math.random() - 0.5) * spread;
    windPositions[i*3+2] = (Math.random() - 0.5) * spread;
    const d = STORM_DATA[currentLevel];
    windVelocities[i*3]   = d.windSpeed * (0.8 + Math.random() * 0.4);
    windVelocities[i*3+1] = (Math.random() - 0.5) * 0.02;
    windVelocities[i*3+2] = (Math.random() - 0.5) * 0.02;
  }

  /* ─────────────────────────────────────────────────────────
     LINHAS DE VENTO SOLAR
     Laranja (#ff7700), fluxo Sol→Terra animado
     A deflexão ao redor da magnetopausa comprimida está
     embutida na geometria e fica visível com o fluxo animado.
  ───────────────────────────────────────────────────────── */
  function buildWindLines() {
    windLineGroup = new THREE.Group();
    scene.add(windLineGroup);
    drawWindLines();
  }

  function drawWindLines() {
    windLineGroup.children.forEach(c => { if (c.material) c.material.dispose(); });
    windLineGroup.clear();
    windUniforms = [];

    const d  = STORM_DATA[currentLevel];
    const cf = d.compressionFactor;

    // 20 linhas em leque saindo do Sol
    const nLines = 20;
    for (let i = 0; i < nLines; i++) {
      const angle = (i / nLines) * Math.PI * 2;
      const ySpr  = Math.cos(angle) * 13;
      const zSpr  = Math.sin(angle) * 13;

      const pts = [];
      // ponto de origem na superfície do Sol
      pts.push(new THREE.Vector3(SUN_X + 8, ySpr * 0.5, zSpr * 0.5));

      const steps = 80;
      for (let s = 1; s <= steps; s++) {
        const fx = s / steps;
        // avanço em x: do Sol até além da Terra
        const x = SUN_X + 8 + fx * (44 + 9 * d.windSpeed);
        const y = ySpr * (1 - fx * 0.90);
        const z = zSpr * (1 - fx * 0.90);

        const dist    = Math.sqrt(x*x + y*y + z*z);
        const shieldR = 9 * cf;   // raio da magnetopausa — diminui com tempestade

        if (dist < shieldR && x > -6) {
          // deflexão: empurra a linha para fora da magnetopausa
          const yzLen = Math.sqrt(y*y + z*z) + 0.001;
          const push  = (shieldR - dist + 2.0) * 0.70;
          pts.push(new THREE.Vector3(x, y + (y / yzLen) * push, z + (z / yzLen) * push));
        } else {
          pts.push(new THREE.Vector3(x, y, z));
        }
      }
      if (pts.length < 2) continue;

      // linhas a cada 4 são mais brilhantes (destacam o padrão)
      const opacity    = i % 4 === 0 ? 0.60 : 0.22;
      const period     = 0.80;
      const dashRatio  = 0.50;

      const { line, uniforms } = makeFlowLine(pts, 0xff7700, opacity, period, dashRatio);
      windLineGroup.add(line);
      windUniforms.push(uniforms);
    }

    windLineGroup.visible = showWindLines;
  }

  /* ─────────────────────────────────────────────────────────
     TRAJETÓRIA DO SATÉLITE — linha branca simples (sem alteração)
  ───────────────────────────────────────────────────────── */
  function buildSatOrbitLine() {
    const pts = [];
    for (let i = 0; i <= 200; i++) {
      const a = (i / 200) * Math.PI * 2;
      pts.push(new THREE.Vector3(
        Math.cos(a) * SAT_R,
        Math.sin(a) * SAT_R * Math.sin(SAT_INC),
        Math.sin(a) * SAT_R * Math.cos(SAT_INC)
      ));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({ color:0x334466, transparent:true, opacity:0.35, depthWrite:false });
    satOrbitLine = new THREE.Line(geo, mat);
    scene.add(satOrbitLine);
  }

  /* ─────────────────────────────────────────────────────────
     SATÉLITE
  ───────────────────────────────────────────────────────── */
  function buildSatellite() {
    satelliteGroup = new THREE.Group();
    const silver = new THREE.MeshPhongMaterial({ color:0xcccccc, shininess:90, specular:0x888888 });
    const gold   = new THREE.MeshPhongMaterial({ color:0xddaa22, shininess:60 });
    const blue   = new THREE.MeshPhongMaterial({ color:0x1133aa, shininess:30 });
    const dark   = new THREE.MeshPhongMaterial({ color:0x333333, shininess:20 });
    const white  = new THREE.MeshPhongMaterial({ color:0xffffff, shininess:50 });

    const body  = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.22, 0.22), silver);
    const front = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.14, 0.005), dark);
    front.position.set(0, 0, 0.113); body.add(front);
    const thr = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.055, 0.06, 12), dark);
    thr.rotation.z = Math.PI / 2; thr.position.x = 0.17; body.add(thr);

    function makePanel(side) {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.005, 0.20), silver));
      for (let cx = 0; cx < 3; cx++) for (let cz = 0; cz < 2; cz++) {
        const c = new THREE.Mesh(new THREE.BoxGeometry(0.155, 0.006, 0.085), blue);
        c.position.set(-0.18 + cx * 0.175, 0, -0.05 + cz * 0.10);
        g.add(c);
      }
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.15, 6), silver);
      arm.rotation.z = Math.PI / 2; arm.position.x = side < 0 ? 0.075 : -0.075; g.add(arm);
      g.position.x = side * 0.42;
      return g;
    }

    const dish = new THREE.Group();
    const dm   = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.04, 16, 1, true), white);
    dm.rotation.z = -Math.PI / 2;
    const da = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.12, 6), silver);
    da.rotation.z = Math.PI / 2; da.position.x = -0.06;
    dish.add(dm, da); dish.position.set(0, 0.155, 0); dish.rotation.z = Math.PI / 6;

    function ant(px, py, pz, rx, ry, rz) {
      const a = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, 0.22, 4), white);
      a.position.set(px, py, pz); a.rotation.set(rx, ry, rz);
      return a;
    }
    const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.06, 12), gold);
    tr.rotation.z = Math.PI / 2; tr.position.set(0, 0.12, -0.12);

    satelliteGroup.add(body, makePanel(-1), makePanel(1), dish,
      ant(0, 0.18, 0.05, 0.3, 0, 0),
      ant(0.05, 0.16, -0.08, -0.2, 0.1, 0.1),
      ant(-0.06, 0.15, 0.07, 0.1, -0.1, -0.15),
      tr
    );
    satWarningLight = new THREE.PointLight(0xff3300, 0, 2.5);
    satelliteGroup.add(satWarningLight);
    scene.add(satelliteGroup);
  }

  /* ─────────────────────────────────────────────────────────
     UI
  ───────────────────────────────────────────────────────── */
  function setupUI() {
    document.body.dataset.level = currentLevel;

    document.getElementById('stormButtons').addEventListener('click', e => {
      const btn = e.target.closest('.storm-btn');
      if (!btn) return;
      const lvl = parseInt(btn.dataset.level, 10);
      document.querySelectorAll('.storm-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      applyStormLevel(lvl);
    });

    document.getElementById('btnPause').addEventListener('click', () => {
      paused = !paused;
      document.getElementById('btnPause').innerHTML = paused
        ? '<svg width="14" height="14" viewBox="0 0 14 14"><polygon points="2,1 12,7 2,13" fill="currentColor"/></svg> Retomar'
        : '<svg width="14" height="14" viewBox="0 0 14 14"><rect x="2" y="1" width="4" height="12" rx="1" fill="currentColor"/><rect x="8" y="1" width="4" height="12" rx="1" fill="currentColor"/></svg> Pausar';
    });

    document.getElementById('btnReset').addEventListener('click', () => {
      orbit.s.theta = -0.3; orbit.s.phi = 1.1; orbit.s.radius = 22;
      orbit.target.set(0, 0, 0); orbitApply();
    });

    document.getElementById('speedSlider').addEventListener('input', e => {
      simSpeed = parseFloat(e.target.value);
      document.getElementById('speedVal').textContent = simSpeed.toFixed(1) + '×';
    });

    document.getElementById('toggleFieldLines').addEventListener('change', e => {
      showFieldLines = e.target.checked;
      fieldLineGroup.visible = showFieldLines;
    });
    document.getElementById('toggleWindLines').addEventListener('change', e => {
      showWindLines = e.target.checked;
      windLineGroup.visible  = showWindLines;
      windParticles.visible  = showWindLines;   // partículas seguem o mesmo toggle
    });
    document.getElementById('toggleVanAllen').addEventListener('change', e => {
      showVanAllen = e.target.checked;
      innerBelt.visible = showVanAllen;
      outerBelt.visible = showVanAllen;
    });
    document.getElementById('toggleSatellite').addEventListener('change', e => {
      showSatellite = e.target.checked;
      satelliteGroup.visible = showSatellite;
      satOrbitLine.visible   = showSatellite;
    });

    // ── Toggle do card de informações ──────────────────────
    const panelToggleBtn  = document.getElementById('infoPanelToggle');
    const panelBody       = document.getElementById('infoPanelBody');
    let panelCollapsed = false;

    panelToggleBtn.addEventListener('click', () => {
      panelCollapsed = !panelCollapsed;
      panelBody.classList.toggle('hidden', panelCollapsed);
      panelToggleBtn.classList.toggle('collapsed', panelCollapsed);
    });

    setTimeout(() => {
      const h = document.getElementById('camHint');
      if (h) h.style.opacity = '0';
    }, 6000);
  }

  /* ─────────────────────────────────────────────────────────
     APLICAR NÍVEL
  ───────────────────────────────────────────────────────── */
  function applyStormLevel(lvl) {
    currentLevel = lvl;
    document.body.dataset.level = lvl;
    const d = STORM_DATA[lvl];

    document.getElementById('stormBadge').textContent   = d.badge;
    document.getElementById('stormName').textContent    = d.name;
    document.getElementById('stormKp').textContent      = d.kp;
    document.getElementById('statSpeed').textContent    = d.speed;
    document.getElementById('statDensity').textContent  = d.density;
    document.getElementById('statBfield').textContent   = d.bfield;
    document.getElementById('statAurora').textContent   = d.aurora;
    document.getElementById('infoDesc').textContent     = d.desc;

    const rEl = document.getElementById('statRisk');
    rEl.textContent = d.risk;
    rEl.style.color = { low:'#44bb88', moderate:'#f0c040', high:'#f07030', critical:'#ff4422', extreme:'#ff2200' }[d.riskClass] || '#aaaaaa';

    // reconstrói linhas (nova geometria de deflexão)
    drawFieldLines();
    drawWindLines();

    // Van Allen
    const bs = 1 + lvl * 0.08;
    innerBelt.material.opacity = 0.20 + lvl * 0.05;
    outerBelt.material.opacity = 0.14 + lvl * 0.06;
    innerBelt.scale.setScalar(bs);
    outerBelt.scale.setScalar(bs);

    // magnetopausa (visual)
    magnetosheath.scale.set(14 * d.compressionFactor, 9, 9);

    // velocidades das partículas
    const MAX = windPositions.length / 3;
    for (let i = 0; i < MAX; i++)
      windVelocities[i*3] = d.windSpeed * (0.8 + Math.random() * 0.4);

    stormLight.intensity = lvl * 0.45;
    stormLight.color.setHex(LEVEL_COLORS[lvl]);
    sunLight.intensity = 2.2 + lvl * 0.3;
    sunLight.color.copy(new THREE.Color(0xfff0cc).lerp(new THREE.Color(0xffaa44), lvl / 5));
  }

  /* ─────────────────────────────────────────────────────────
     LOOP DE ANIMAÇÃO
  ───────────────────────────────────────────────────────── */
  function animate() {
    requestAnimationFrame(animate);
    if (paused) { renderer.render(scene, camera); return; }

    const dt = Math.min(clock.getDelta(), 0.05) * simSpeed;
    globalTime += dt;
    const t = globalTime;

    // Terra
    earth.rotation.y     += dt * 0.05;
    earthAtmo.rotation.y  = earth.rotation.y;

    // Sol
    if (sunMesh) sunMesh.rotation.y += dt * 0.015;
    if (sunGlow) sunGlow.scale.setScalar(1 + 0.06 * Math.sin(t * 1.1));

    // Partículas
    updateWindParticles(dt);

    // ── AVANÇAR uOffset das linhas de campo (polo→polo)
    // velocidade de fluxo escala com intensidade da tempestade
    const fSpeed = 0.10 + STORM_DATA[currentLevel].windSpeed * 0.06;
    for (const u of fieldUniforms) u.uOffset.value += fSpeed * dt;

    // ── AVANÇAR uOffset das linhas de vento (Sol→Terra)
    // sentido negativo: offset decresce, pontos se movem no sentido +x (Sol→Terra)
    const wSpeed = 0.25 + STORM_DATA[currentLevel].windSpeed * 0.15;
    for (const u of windUniforms) u.uOffset.value -= wSpeed * dt;

    // Satélite
    if (showSatellite) {
      satAngle += dt * 0.28;
      satelliteGroup.position.set(
        Math.cos(satAngle) * SAT_R,
        Math.sin(satAngle) * SAT_R * Math.sin(SAT_INC),
        Math.sin(satAngle) * SAT_R * Math.cos(SAT_INC)
      );
      satelliteGroup.rotation.y = -satAngle;

      const dv = STORM_DATA[currentLevel];
      satWarningLight.intensity = dv.satRisk > 0.2
        ? ((Math.sin(t * (4 + dv.satRisk * 8)) + 1) * 0.5) * dv.satRisk * 2
        : 0;
      if (dv.satRisk > 0.2) satWarningLight.color.setHex(LEVEL_COLORS[currentLevel]);
    }

    // Auroras
    const da = STORM_DATA[currentLevel];
    const auroraPulse = da.auroraIntensity * (0.82 + 0.18 * Math.sin(t * 2.1));
    auroraNorth.material.opacity = auroraPulse * 0.80;
    auroraSouth.material.opacity = auroraPulse * 0.80;

    // Cinturões
    if (showVanAllen) {
      innerBelt.material.emissiveIntensity = 0.35 + 0.12 * Math.sin(t * 0.7);
      outerBelt.material.emissiveIntensity = 0.28 + 0.14 * Math.sin(t * 0.5 + 1);
    }

    renderer.render(scene, camera);
  }

  /* ─────────────────────────────────────────────────────────
     PARTÍCULAS UPDATE
  ───────────────────────────────────────────────────────── */
  function updateWindParticles(dt) {
    const d      = STORM_DATA[currentLevel];
    const MAX    = windPositions.length / 3;
    const active = Math.floor(d.particleCount);

    for (let i = 0; i < MAX; i++) {
      if (i >= active) { windPositions[i*3] = -9999; continue; }

      windPositions[i*3]   += windVelocities[i*3]   * dt * 8;
      windPositions[i*3+1] += windVelocities[i*3+1] * dt * 8;
      windPositions[i*3+2] += windVelocities[i*3+2] * dt * 8;

      const px = windPositions[i*3], py = windPositions[i*3+1], pz = windPositions[i*3+2];
      const dist   = Math.sqrt(px*px + py*py + pz*pz);
      const shield = 8 * d.compressionFactor;

      if (dist < shield && px > -2) {
        const def = 0.6 / (dist + 0.5);
        windPositions[i*3+1] += py * def * dt * 4;
        windPositions[i*3+2] += pz * def * dt * 4;
        windVelocities[i*3]  *= 0.97;
      }
      if (windPositions[i*3] > 30 || dist < 2.5) resetParticle(i);
    }
    windParticles.geometry.attributes.position.needsUpdate = true;
  }

  /* ─────────────────────────────────────────────────────────
     RESIZE
  ───────────────────────────────────────────────────────── */
  function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }

  window.addEventListener('DOMContentLoaded', init);
})();
