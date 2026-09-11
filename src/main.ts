import './style.css';
import * as THREE from 'three';
import {
  createInitialState,
  type GameState,
  type Unit,
  type CommanderType,
  type UnderlingType,
  getUnitAt,
  getDeployTiles,
  UNDERLING_STATS,
} from './gameState';
import { GameController } from './gameController';
import { mountDashboard } from './dashboard';

const TILE_SIZE = 1;
const TILE_GAP = 0.08;
const TILE_HEIGHT = 0.3;
const COMMANDER_BASE_Y = 0.8;
const UNDERLING_BASE_Y = 0.12;

const state: GameState = createInitialState();
const controller = new GameController(state);
const halfBoard = (state.gridSize * (TILE_SIZE + TILE_GAP) - TILE_GAP) / 2;

function gridToWorld(gx: number, gy: number): { x: number; z: number } {
  const step = TILE_SIZE + TILE_GAP;
  return {
    x: gx * step - halfBoard + TILE_SIZE / 2,
    z: gy * step - halfBoard + TILE_SIZE / 2,
  };
}

function worldToGrid(x: number, z: number): { gridX: number; gridY: number } {
  const step = TILE_SIZE + TILE_GAP;
  const gx = Math.round((x + halfBoard - TILE_SIZE / 2) / step);
  const gy = Math.round((z + halfBoard - TILE_SIZE / 2) / step);
  return { gridX: gx, gridY: gy };
}

const container = document.getElementById('game-container')!;
const overlay = document.getElementById('overlay-container')!;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a2e);
scene.fog = new THREE.Fog(0x1a1a2e, 20, 45);

const camera = new THREE.PerspectiveCamera(
  45,
  window.innerWidth / window.innerHeight,
  0.1,
  100,
);
camera.position.set(14, 14, 14);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.appendChild(renderer.domElement);

const ambient = new THREE.AmbientLight(0x9090b0, 0.6);
scene.add(ambient);

const dirLight = new THREE.DirectionalLight(0xffffff, 1.4);
dirLight.position.set(8, 16, 6);
dirLight.castShadow = true;
dirLight.shadow.mapSize.set(2048, 2048);
dirLight.shadow.camera.left = -12;
dirLight.shadow.camera.right = 12;
dirLight.shadow.camera.top = 12;
dirLight.shadow.camera.bottom = -12;
dirLight.shadow.camera.near = 0.5;
dirLight.shadow.camera.far = 40;
dirLight.shadow.bias = -0.0005;
scene.add(dirLight);

const boardGroup = new THREE.Group();
scene.add(boardGroup);

const tileGeo = new THREE.BoxGeometry(TILE_SIZE, TILE_HEIGHT, TILE_SIZE);

for (let gy = 0; gy < state.gridSize; gy++) {
  for (let gx = 0; gx < state.gridSize; gx++) {
    const isLight = (gx + gy) % 2 === 0;
    const mat = new THREE.MeshStandardMaterial({
      color: isLight ? 0x3a3a52 : 0x2a2a3e,
      roughness: 0.95,
      metalness: 0.0,
    });
    const tile = new THREE.Mesh(tileGeo, mat);
    const { x, z } = gridToWorld(gx, gy);
    tile.position.set(x, -TILE_HEIGHT / 2, z);
    tile.receiveShadow = true;
    tile.castShadow = false;
    boardGroup.add(tile);
  }
}

const groundGeo = new THREE.PlaneGeometry(60, 60);
const groundMat = new THREE.MeshStandardMaterial({
  color: 0x12121f,
  roughness: 1.0,
  metalness: 0.0,
});
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -TILE_HEIGHT;
ground.receiveShadow = true;
scene.add(ground);

const commanderColors: Record<CommanderType, number> = {
  Warlord: 0x2a2a2a,
  Necromancer: 0x1a1a22,
  Engineer: 0x8a6a2a,
};

const commanderRoughness: Record<CommanderType, number> = {
  Warlord: 0.9,
  Necromancer: 0.35,
  Engineer: 0.6,
};

const commanderMetalness: Record<CommanderType, number> = {
  Warlord: 0.1,
  Necromancer: 0.5,
  Engineer: 0.7,
};

function createCommanderMesh(type: CommanderType): THREE.Mesh {
  let geo: THREE.BufferGeometry;
  switch (type) {
    case 'Warlord':
      geo = new THREE.TetrahedronGeometry(0.38);
      break;
    case 'Necromancer':
      geo = new THREE.TorusGeometry(0.3, 0.1, 12, 24);
      break;
    case 'Engineer':
      geo = new THREE.CylinderGeometry(0.28, 0.32, 0.6, 6);
      break;
  }
  const mat = new THREE.MeshStandardMaterial({
    color: commanderColors[type],
    roughness: commanderRoughness[type],
    metalness: commanderMetalness[type],
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  return mesh;
}

function createUnderlingMesh(_type: UnderlingType, ownerColor: number): THREE.Mesh {
  const geo = new THREE.CylinderGeometry(0.22, 0.22, 0.18, 16);
  const mat = new THREE.MeshStandardMaterial({
    color: ownerColor,
    roughness: 0.7,
    metalness: 0.2,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  return mesh;
}

interface UnitView {
  unitId: number;
  mesh: THREE.Mesh;
  baseY: number;
  phase: number;
  rotSpeed: number;
  target: THREE.Vector3;
}

const unitViews = new Map<number, UnitView>();

function createViewForUnit(unit: Unit): UnitView {
  let mesh: THREE.Mesh;
  let baseY: number;

  if (unit.kind === 'commander') {
    mesh = createCommanderMesh(unit.type as CommanderType);
    baseY = COMMANDER_BASE_Y;
  } else {
    const owner = state.players[unit.ownerId];
    mesh = createUnderlingMesh(unit.type as UnderlingType, owner.color);
    baseY = UNDERLING_BASE_Y;
  }

  const { x, z } = gridToWorld(unit.gridX, unit.gridY);
  mesh.position.set(x, baseY, z);
  scene.add(mesh);

  return {
    unitId: unit.id,
    mesh,
    baseY,
    phase: Math.random() * Math.PI * 2,
    rotSpeed: 0.3 + Math.random() * 0.4,
    target: new THREE.Vector3(x, baseY, z),
  };
}

function reconcileUnits(): void {
  const currentIds = new Set(state.units.map((u) => u.id));

  for (const [id, view] of unitViews) {
    if (!currentIds.has(id)) {
      scene.remove(view.mesh);
      view.mesh.geometry.dispose();
      (view.mesh.material as THREE.Material).dispose();
      unitViews.delete(id);
    }
  }

  for (const unit of state.units) {
    let view = unitViews.get(unit.id);
    if (!view) {
      view = createViewForUnit(unit);
      unitViews.set(unit.id, view);
    }
    const { x, z } = gridToWorld(unit.gridX, unit.gridY);
    view.target.x = x;
    view.target.z = z;
  }
}

reconcileUnits();

const raycastPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

renderer.domElement.addEventListener('click', onCanvasClick);
renderer.domElement.addEventListener('pointermove', onPointerMove);

const hoverMat = new THREE.MeshBasicMaterial({
  color: 0x66ccff,
  transparent: true,
  opacity: 0.25,
});
const hoverGeo = new THREE.BoxGeometry(TILE_SIZE, TILE_HEIGHT * 1.02, TILE_SIZE);
const hoverMesh = new THREE.Mesh(hoverGeo, hoverMat);
hoverMesh.visible = false;
scene.add(hoverMesh);

const deployHighlightMat = new THREE.MeshBasicMaterial({
  color: 0x44ff88,
  transparent: true,
  opacity: 0.15,
});
const deployHighlights: THREE.Mesh[] = [];

function clearDeployHighlights(): void {
  for (const m of deployHighlights) {
    scene.remove(m);
    m.geometry.dispose();
  }
  deployHighlights.length = 0;
}

function showDeployHighlights(): void {
  clearDeployHighlights();
  if (state.phase !== 'DEPLOY') return;
  const tiles = getDeployTiles(state, controller.activePlayer.id);
  for (const t of tiles) {
    const geo = new THREE.BoxGeometry(TILE_SIZE * 0.9, 0.02, TILE_SIZE * 0.9);
    const m = new THREE.Mesh(geo, deployHighlightMat.clone());
    const { x, z } = gridToWorld(t.x, t.y);
    m.position.set(x, 0.02, z);
    scene.add(m);
    deployHighlights.push(m);
  }
}

function onPointerMove(e: MouseEvent) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hit = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(raycastPlane, hit)) {
    const { gridX, gridY } = worldToGrid(hit.x, hit.z);
    if (gridX >= 0 && gridX < state.gridSize && gridY >= 0 && gridY < state.gridSize) {
      const { x, z } = gridToWorld(gridX, gridY);
      hoverMesh.position.set(x, -TILE_HEIGHT / 2, z);
      hoverMesh.visible = true;
      return;
    }
  }
  hoverMesh.visible = false;
}

function flashSelect(view: UnitView) {
  const mat = view.mesh.material as THREE.MeshStandardMaterial;
  const orig = mat.emissive.getHex();
  mat.emissive.setHex(0x444466);
  setTimeout(() => mat.emissive.setHex(orig), 250);
}

function onCanvasClick(e: MouseEvent) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hit = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(raycastPlane, hit)) return;
  const { gridX, gridY } = worldToGrid(hit.x, hit.z);
  if (gridX < 0 || gridX >= state.gridSize || gridY < 0 || gridY >= state.gridSize)
    return;

  const clickedUnit = getUnitAt(state, gridX, gridY);
  const phase = state.phase;
  const activePlayer = controller.activePlayer;

  if (phase === 'DEPLOY') {
    if (clickedUnit) {
      controller.selectUnit(clickedUnit);
      const view = unitViews.get(clickedUnit.id);
      if (view) flashSelect(view);
      return;
    }
    const result = controller.deploy(gridX, gridY);
    if (result.ok && result.unit) {
      spawnDamagePopup(hit, `+${UNDERLING_STATS[result.unit.type as UnderlingType].cost}`, 0x44ff88);
    } else if (result.reason) {
      spawnDamagePopup(hit, result.reason, 0xff6666);
    }
    return;
  }

  if (phase === 'MOVE') {
    if (clickedUnit) {
      if (clickedUnit.ownerId === activePlayer.id) {
        controller.selectUnit(clickedUnit);
        const view = unitViews.get(clickedUnit.id);
        if (view) flashSelect(view);
      }
      return;
    }
    const selected = controller.getSelectedUnit();
    if (selected) {
      const ok = controller.moveUnit(selected, gridX, gridY);
      if (ok) {
        controller.selectUnit(null);
      }
    }
    return;
  }

  if (phase === 'ACTION') {
    if (clickedUnit) {
      const selected = controller.getSelectedUnit();
      if (selected && clickedUnit.ownerId !== activePlayer.id) {
        const result = controller.attack(selected, clickedUnit);
        if (result.ok && result.damage !== undefined) {
          const color = result.killed ? 0xff0000 : 0xff4444;
          spawnDamagePopup(hit, `-${result.damage}`, color);
        } else if (result.reason) {
          spawnDamagePopup(hit, result.reason, 0xff6666);
        }
      } else if (clickedUnit.ownerId === activePlayer.id) {
        controller.selectUnit(clickedUnit);
        const view = unitViews.get(clickedUnit.id);
        if (view) flashSelect(view);
      }
    }
    return;
  }
}

function spawnDamagePopup(worldPos: THREE.Vector3, text: string, color: number) {
  const screen = worldToScreen(worldPos);
  const div = document.createElement('div');
  div.className = 'damage-popup';
  div.textContent = text;
  div.style.left = `${screen.x}px`;
  div.style.top = `${screen.y}px`;
  const hex = `#${color.toString(16).padStart(6, '0')}`;
  div.style.color = hex;
  div.style.textShadow = `0 0 8px ${hex}99, 0 2px 4px rgba(0,0,0,0.8)`;
  overlay.appendChild(div);
  setTimeout(() => div.remove(), 1200);
}

function worldToScreen(worldPos: THREE.Vector3): { x: number; y: number } {
  const v = worldPos.clone();
  v.y += 1.0;
  v.project(camera);
  return {
    x: (v.x * 0.5 + 0.5) * window.innerWidth,
    y: (-v.y * 0.5 + 0.5) * window.innerHeight,
  };
}

mountDashboard(controller, overlay);

controller.subscribe((event) => {
  if (event.type === 'state-changed' || event.type === 'phase-changed') {
    reconcileUnits();
    showDeployHighlights();
  }
  if (event.type === 'unit-selected' && event.unit) {
    const view = unitViews.get(event.unit.id);
    if (view) flashSelect(view);
  }
});

showDeployHighlights();

const clock = new THREE.Clock();
const hoverSpeed = 1.5;
const hoverAmplitude = 0.12;
const underlingHoverSpeed = 2.0;
const underlingHoverAmplitude = 0.04;

function animate() {
  requestAnimationFrame(animate);
  const t = clock.getElapsedTime();

  for (const view of unitViews.values()) {
    view.mesh.position.x = THREE.MathUtils.lerp(view.mesh.position.x, view.target.x, 0.1);
    view.mesh.position.z = THREE.MathUtils.lerp(view.mesh.position.z, view.target.z, 0.1);

    const isCommander = view.baseY === COMMANDER_BASE_Y;
    const speed = isCommander ? hoverSpeed : underlingHoverSpeed;
    const amp = isCommander ? hoverAmplitude : underlingHoverAmplitude;
    view.mesh.position.y = view.baseY + Math.sin(t * speed + view.phase) * amp;

    view.mesh.rotation.y += 0.008 * view.rotSpeed;
    if (isCommander) {
      view.mesh.rotation.x += 0.003 * view.rotSpeed;
    }
  }

  renderer.render(scene, camera);
}

animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
