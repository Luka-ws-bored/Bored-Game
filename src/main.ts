import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  type GameState, type Unit, type Hero, type Tile, type Die,
  type UnitClass, type PropertyType, type AbilityId, type HeroClass,
  type ActionTargetType, type Player, type VoidZoneState,
  chebyshevDistance, BOARD_SIZE, SPAWN_THRESHOLDS, MAX_UNITS_PER_PLAYER, UNIT_CLASS_OWNER
} from './gameState';
import { GameController } from './gameController';

// ----------------------------------------------------
// UI STATE MACHINE
// ----------------------------------------------------
type UIState = 'IDLE' | 'DIE_SELECTED' | 'SPELL_TARGETING' | 'FREE_ACTION_TARGETING';
let uiState: UIState = 'IDLE';
let selectedDieId: string | null = null;
let pendingAction: 
  | { kind: 'SPAWN', unitClass: UnitClass } 
  | { kind: 'SPELL', abilityId: AbilityId } 
  | { kind: 'UPGRADE_PROPERTY', propertyType: PropertyType }
  | { kind: 'FREE_ACTION', abilityId: 'NECROMANCER_SACRIFICE' | 'NECROMANCER_SHADOWSTEP' } 
  | null = null;
let selectedUnitId: string | null = null;

// window global for skip flag
declare global {
  interface Window { skippedFreeAction: boolean; }
}
window.skippedFreeAction = false;

// ----------------------------------------------------
// ENGINE INIT
// ----------------------------------------------------
function createInitialState(): GameState {
  const tiles: Tile[] = [];
  for (let y = 0; y < BOARD_SIZE; y++) {
    for (let x = 0; x < BOARD_SIZE; x++) {
      tiles.push({
        x, y, type: 'NORMAL', ownerId: null, infusionTag: null,
        property: 'NONE', propertyOwnerId: null, hasCorpse: false, bomb: null, tempEffect: null
      });
    }
  }

  const p1: Player = { id: 'P1', heroId: 'H1', essence: 0, ownedTileCoords: [{x:0, y:0}], unitIds: [] };
  const p2: Player = { id: 'P2', heroId: 'H2', essence: 0, ownedTileCoords: [{x:BOARD_SIZE-1, y:BOARD_SIZE-1}], unitIds: [] };
  
  tiles[0].ownerId = 'P1';
  tiles[BOARD_SIZE * BOARD_SIZE - 1].ownerId = 'P2';

  const h1: Hero = { id: 'H1', ownerId: 'P1', heroClass: 'WARLORD', hp: 20, maxHp: 20, atk: 4, def: 2, x: 0, y: 0, freeActionUsed: false, tempEffects: [], abilitiesUsedThisTurn: [] };
  const h2: Hero = { id: 'H2', ownerId: 'P2', heroClass: 'NECROMANCER', hp: 20, maxHp: 20, atk: 4, def: 2, x: BOARD_SIZE-1, y: BOARD_SIZE-1, freeActionUsed: false, tempEffects: [], abilitiesUsedThisTurn: [] };

  return {
    turnNumber: 1, activePlayerId: 'P1', phase: 'ESSENCE_GENERATION',
    board: { width: BOARD_SIZE, height: BOARD_SIZE, tiles },
    players: [p1, p2], heroes: [h1, h2], units: [], currentDiceRoll: [],
    voidZone: { active: false, ringsShrunk: 0 }, winnerId: null, gameOver: false
  };
}

const state: GameState = createInitialState();
const controller = new GameController(state);

function getUnitAt(st: GameState, x: number, y: number): Unit | undefined {
  return st.units.find(u => u.x === x && u.y === y);
}
function getHeroAt(st: GameState, x: number, y: number): Hero | undefined {
  return st.heroes.find(h => h.x === x && h.y === y);
}

// ----------------------------------------------------
// SCENE SETUP
// ----------------------------------------------------
const TILE_SIZE = 1;
const TILE_GAP = 0.08;
const TILE_HEIGHT = 0.3;
const COMMANDER_BASE_Y = 0.8;
const UNDERLING_BASE_Y = 0.12;
const halfBoard = (state.board.width * (TILE_SIZE + TILE_GAP) - TILE_GAP) / 2;

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
overlay.innerHTML = ''; // reset

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a2e);
scene.fog = new THREE.Fog(0x1a1a2e, 20, 45);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(14, 14, 14);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI / 2.2;
controls.minDistance = 10;
controls.maxDistance = 40;
controls.enablePan = false;

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
const tileMeshes: THREE.Mesh[] = [];

for (let gy = 0; gy < state.board.height; gy++) {
  for (let gx = 0; gx < state.board.width; gx++) {
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
    tileMeshes.push(tile);
  }
}

const PLAYER_COLORS = [0x4488ff, 0xff4466];

function reconcileTiles(): void {
  for (let gy = 0; gy < state.board.height; gy++) {
    for (let gx = 0; gx < state.board.width; gx++) {
      const idx = gy * state.board.width + gx;
      const tileData = state.board.tiles[idx];
      const mesh = tileMeshes[idx];
      const mat = mesh.material as THREE.MeshStandardMaterial;
      
      if (tileData.type === 'WALL') {
        mat.color.setHex(0x111111);
      } else if (tileData.ownerId !== null) {
        const pIdx = state.players.findIndex(p => p.id === tileData.ownerId);
        mat.color.setHex(PLAYER_COLORS[pIdx]);
      } else {
        const isLight = (gx + gy) % 2 === 0;
        mat.color.setHex(isLight ? 0x3a3a52 : 0x2a2a3e);
      }
    }
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

const commanderColors: Record<HeroClass, number> = {
  WARLORD: 0x2a2a2a,
  NECROMANCER: 0x1a1a22,
  ENGINEER: 0x8a6a2a,
};
const commanderRoughness: Record<HeroClass, number> = {
  WARLORD: 0.9,
  NECROMANCER: 0.35,
  ENGINEER: 0.6,
};
const commanderMetalness: Record<HeroClass, number> = {
  WARLORD: 0.1,
  NECROMANCER: 0.5,
  ENGINEER: 0.7,
};

function createCommanderMesh(type: HeroClass): THREE.Mesh {
  let geo: THREE.BufferGeometry;
  switch (type) {
    case 'WARLORD': geo = new THREE.TetrahedronGeometry(0.38); break;
    case 'NECROMANCER': geo = new THREE.TorusGeometry(0.3, 0.1, 12, 24); break;
    case 'ENGINEER': geo = new THREE.CylinderGeometry(0.28, 0.32, 0.6, 6); break;
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

function createUnderlingMesh(_type: UnitClass, ownerColor: number): THREE.Mesh {
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

interface EntityView {
  id: string;
  mesh: THREE.Mesh;
  baseY: number;
  phase: number;
  rotSpeed: number;
  target: THREE.Vector3;
}
const entityViews = new Map<string, EntityView>();

function createViewForEntity(entity: Unit | Hero, isHero: boolean): EntityView {
  let mesh: THREE.Mesh;
  let baseY: number;

  if (isHero) {
    mesh = createCommanderMesh((entity as Hero).heroClass);
    baseY = COMMANDER_BASE_Y;
  } else {
    const ownerIndex = state.players.findIndex(p => p.id === entity.ownerId);
    mesh = createUnderlingMesh((entity as Unit).unitClass, PLAYER_COLORS[ownerIndex]);
    baseY = UNDERLING_BASE_Y;
  }

  const { x, z } = gridToWorld(entity.x, entity.y);
  mesh.position.set(x, baseY, z);
  scene.add(mesh);

  return {
    id: entity.id,
    mesh,
    baseY,
    phase: Math.random() * Math.PI * 2,
    rotSpeed: 0.3 + Math.random() * 0.4,
    target: new THREE.Vector3(x, baseY, z),
  };
}

function reconcileEntities(): void {
  const currentIds = new Set<string>();
  state.units.forEach(u => currentIds.add(u.id));
  state.heroes.forEach(h => currentIds.add(h.id));

  for (const [id, view] of entityViews) {
    if (!currentIds.has(id)) {
      scene.remove(view.mesh);
      view.mesh.geometry.dispose();
      (view.mesh.material as THREE.Material).dispose();
      entityViews.delete(id);
    }
  }

  for (const unit of state.units) {
    let view = entityViews.get(unit.id);
    if (!view) {
      view = createViewForEntity(unit, false);
      entityViews.set(unit.id, view);
    }
    const { x, z } = gridToWorld(unit.x, unit.y);
    view.target.x = x;
    view.target.z = z;
  }
  for (const hero of state.heroes) {
    let view = entityViews.get(hero.id);
    if (!view) {
      view = createViewForEntity(hero, true);
      entityViews.set(hero.id, view);
    }
    const { x, z } = gridToWorld(hero.x, hero.y);
    view.target.x = x;
    view.target.z = z;
  }
}

// ----------------------------------------------------
// UI HUD OVERLAYS
// ----------------------------------------------------
const hudContainer = document.createElement('div');
hudContainer.style.position = 'absolute';
hudContainer.style.top = '0';
hudContainer.style.left = '0';
hudContainer.style.width = '100%';
hudContainer.style.height = '100%';
hudContainer.style.pointerEvents = 'none'; 
overlay.appendChild(hudContainer);

const topHud = document.createElement('div');
topHud.style.position = 'absolute';
topHud.style.top = '20px';
topHud.style.left = '20px';
topHud.style.color = 'white';
topHud.style.fontFamily = 'monospace';
topHud.style.pointerEvents = 'auto';
topHud.style.background = 'rgba(0,0,0,0.5)';
topHud.style.padding = '10px';
hudContainer.appendChild(topHud);

const advanceBtn = document.createElement('button');
advanceBtn.style.position = 'absolute';
advanceBtn.style.bottom = '20px';
advanceBtn.style.right = '20px';
advanceBtn.style.pointerEvents = 'auto';
advanceBtn.style.padding = '10px 20px';
advanceBtn.style.fontSize = '16px';
hudContainer.appendChild(advanceBtn);

const skipFreeActionBtn = document.createElement('button');
skipFreeActionBtn.textContent = 'Skip Free Action';
skipFreeActionBtn.style.position = 'absolute';
skipFreeActionBtn.style.bottom = '60px';
skipFreeActionBtn.style.right = '20px';
skipFreeActionBtn.style.pointerEvents = 'auto';
skipFreeActionBtn.style.padding = '10px 20px';
skipFreeActionBtn.style.fontSize = '16px';
skipFreeActionBtn.style.display = 'none';
hudContainer.appendChild(skipFreeActionBtn);

const diceTray = document.createElement('div');
diceTray.style.position = 'absolute';
diceTray.style.bottom = '20px';
diceTray.style.left = '50%';
diceTray.style.transform = 'translateX(-50%)';
diceTray.style.display = 'flex';
diceTray.style.gap = '10px';
diceTray.style.pointerEvents = 'auto';
hudContainer.appendChild(diceTray);

const actionbar = document.createElement('div');
actionbar.style.position = 'absolute';
actionbar.style.bottom = '20px';
actionbar.style.left = '20px';
actionbar.style.display = 'flex';
actionbar.style.flexDirection = 'column';
actionbar.style.gap = '5px';
actionbar.style.pointerEvents = 'auto';
hudContainer.appendChild(actionbar);

const tooltipEl = document.createElement('div');
tooltipEl.className = 'hover-tooltip';
tooltipEl.innerHTML = `
  <div class="tt-name"></div>
  <div class="tt-stats">
    <div class="tt-label">HP</div><div class="tt-value hp"></div>
    <div class="tt-label">ATK</div><div class="tt-value atk"></div>
    <div class="tt-label">DEF</div><div class="tt-value def"></div>
  </div>
`;
overlay.appendChild(tooltipEl);

const ttName = tooltipEl.querySelector('.tt-name')!;
const ttHp = tooltipEl.querySelector('.tt-value.hp')!;
const ttAtk = tooltipEl.querySelector('.tt-value.atk')!;
const ttDef = tooltipEl.querySelector('.tt-value.def')!;

// ----------------------------------------------------
// UI HUD LOGIC
// ----------------------------------------------------

let currentUpkeepShortfall: string[] = [];

function syncGameState() {
  if (state.gameOver) {
    topHud.innerHTML = `Game Over<br>Winner: ${state.winnerId}`;
    advanceBtn.style.display = 'none';
    diceTray.innerHTML = '';
    actionbar.innerHTML = '';
    return;
  }

  // Auto-progression for non-interactive phases
  let autoProgressed = true;
  while (autoProgressed && !state.gameOver) {
    autoProgressed = false;
    
    if (state.phase === 'ESSENCE_GENERATION') {
      controller.runEssenceGeneration(state.activePlayerId);
      state.phase = 'UPKEEP'; // Add this line to prevent the infinite loop
      // Immediately advance to UPKEEP per rules
      autoProgressed = true; 
    } 
    else if (state.phase === 'UPKEEP') {
      const res = controller.runUpkeep(state.activePlayerId);
      currentUpkeepShortfall = res.unpaidUnitIds;
      if (currentUpkeepShortfall.length === 0) {
        state.phase = 'HERO_FREE_ACTION';
        autoProgressed = true;
      }
    }
  }

  renderHUD();
  reconcileEntities();
  reconcileTiles();
}

function renderHUD() {
  const activePlayer = state.players.find(p => p.id === state.activePlayerId)!;
  const activeHero = state.heroes.find(h => h.id === activePlayer.heroId)!;
  const resourceName = activeHero.heroClass === 'NECROMANCER' ? 'Mana' : 'Essence';
  
  topHud.innerHTML = `Phase: ${state.phase}<br>Player: ${activePlayer.id}<br>${resourceName}: ${activePlayer.essence}`;

  advanceBtn.style.display = 'block';
  advanceBtn.disabled = false;
  skipFreeActionBtn.style.display = 'none';

  if (state.phase === 'UPKEEP') {
    advanceBtn.style.display = 'none'; 
  } else if (state.phase === 'HERO_FREE_ACTION') {
    if (!activeHero.freeActionUsed && !window.skippedFreeAction) {
      advanceBtn.disabled = true;
      skipFreeActionBtn.style.display = 'block';
    } else {
      advanceBtn.textContent = 'Roll Dice';
      advanceBtn.disabled = false;
    }
  } else if (state.phase === 'DICE_ROLL') {
    advanceBtn.textContent = 'Roll Dice';
  } else if (state.phase === 'DICE_ASSIGNMENT') {
    advanceBtn.textContent = 'End Turn';
  } else {
    advanceBtn.textContent = 'Advance';
  }

  diceTray.innerHTML = '';
  if (state.phase === 'DICE_ASSIGNMENT') {
    for (const die of state.currentDiceRoll) {
      const dBtn = document.createElement('button');
      dBtn.textContent = die.faceValue.toString();
      dBtn.style.padding = '15px';
      dBtn.style.fontSize = '20px';
      if (die.consumed) {
        dBtn.disabled = true;
        dBtn.style.background = '#888';
      } else {
        dBtn.onclick = () => {
          uiState = 'DIE_SELECTED';
          selectedDieId = die.id;
          pendingAction = null;
          selectedUnitId = null;
          renderHUD();
        };
        if (selectedDieId === die.id) {
          dBtn.style.border = '3px solid #44ff88';
        }
      }
      diceTray.appendChild(dBtn);
    }
  }

  actionbar.innerHTML = '';
  actionbar.style.display = 'none';

  if (uiState === 'DIE_SELECTED' && selectedDieId) {
    actionbar.style.display = 'flex';
    const die = state.currentDiceRoll.find(d => d.id === selectedDieId)!;
    
    // Spawns
    const allowedSpawns = Object.keys(SPAWN_THRESHOLDS) as UnitClass[];
    for (const uclass of allowedSpawns) {
      // Basic check, actual validation is in ruleset
      if (die.faceValue >= SPAWN_THRESHOLDS[uclass] && activePlayer.unitIds.length < MAX_UNITS_PER_PLAYER) {
        // Only allow appropriate classes
        const allowedByClass = UNIT_CLASS_OWNER[uclass] === activeHero.heroClass;
        if (allowedByClass) {
          const btn = document.createElement('button');
          btn.textContent = `Spawn ${uclass}`;
          btn.onclick = () => {
            pendingAction = { kind: 'SPAWN', unitClass: uclass };
            uiState = 'SPELL_TARGETING';
            renderHUD();
          };
          actionbar.appendChild(btn);
        }
      }
    }

    // Properties
    if (die.faceValue >= 3 && activePlayer.essence >= 4) {
      const pmap: Record<HeroClass, PropertyType> = {
        WARLORD: 'WARLORD_SHRINE',
        ENGINEER: 'ENGINEER_TOWER',
        NECROMANCER: 'NECROMANCER_ALTAR'
      };
      const ptype = pmap[activeHero.heroClass];
      const btn = document.createElement('button');
      btn.textContent = `Build ${ptype}`;
      btn.onclick = () => {
        pendingAction = { kind: 'UPGRADE_PROPERTY', propertyType: ptype };
        uiState = 'SPELL_TARGETING';
        renderHUD();
      };
      actionbar.appendChild(btn);
    }

    // Spells
    const spells: Record<HeroClass, {id: AbilityId, name: string}[]> = {
      WARLORD: [
        {id: 'WARLORD_BLESS', name: 'Bless'},
        {id: 'WARLORD_CURSE', name: 'Curse'},
        {id: 'WARLORD_RALLY', name: 'Rally'},
        {id: 'WARLORD_EXECUTE', name: 'Execute'}
      ],
      ENGINEER: [
        {id: 'ENGINEER_BLESS', name: 'Bless'},
        {id: 'ENGINEER_CURSE', name: 'Curse'},
        {id: 'ENGINEER_FORTIFY', name: 'Fortify'},
        {id: 'ENGINEER_OVERCLOCK', name: 'Overclock'}
      ],
      NECROMANCER: [
        {id: 'NECROMANCER_BLESS', name: 'Bless'},
        {id: 'NECROMANCER_CURSE', name: 'Curse'}
      ]
    };
    
    for (const spell of spells[activeHero.heroClass]) {
      let threshold = 1; // Bless/Curse have no min threshold
      if (spell.id === 'WARLORD_RALLY') threshold = 4;
      if (spell.id === 'WARLORD_EXECUTE') threshold = 5;
      if (spell.id === 'ENGINEER_FORTIFY') threshold = 3;
      if (spell.id === 'ENGINEER_OVERCLOCK') threshold = 4;

      if (die.faceValue >= threshold) {
        const btn = document.createElement('button');
        btn.textContent = `Cast ${spell.name}`;
        if (pendingAction?.kind === 'SPELL' && pendingAction.abilityId === spell.id) {
           btn.style.border = '2px solid #fff';
        }
        btn.onclick = () => {
          pendingAction = { kind: 'SPELL', abilityId: spell.id };
          uiState = 'SPELL_TARGETING';
          renderHUD();
        };
        actionbar.appendChild(btn);
      }
    }
  }

  // Render Free Actions if targeting
  if (uiState === 'FREE_ACTION_TARGETING' && !activeHero.freeActionUsed && !window.skippedFreeAction) {
     actionbar.style.display = 'flex';
     
     const isNecro = activeHero.heroClass === 'NECROMANCER';
     let hasAdjFriendly = false;
     for (const u of state.units) {
        if (u.ownerId === activeHero.ownerId && chebyshevDistance({x:u.x, y:u.y}, {x:activeHero.x, y:activeHero.y}) === 1) {
           hasAdjFriendly = true; break;
        }
     }
     
     if (isNecro) {
       const shadBtn = document.createElement('button');
       shadBtn.textContent = 'Shadowstep';
       if (pendingAction?.kind === 'FREE_ACTION' && pendingAction.abilityId === 'NECROMANCER_SHADOWSTEP') shadBtn.style.border = '2px solid white';
       shadBtn.onclick = () => { pendingAction = {kind:'FREE_ACTION', abilityId:'NECROMANCER_SHADOWSTEP'}; syncGameState(); };
       actionbar.appendChild(shadBtn);
     }
     if (isNecro && hasAdjFriendly) {
       const sacBtn = document.createElement('button');
       sacBtn.textContent = 'Sacrifice';
       if (pendingAction?.kind === 'FREE_ACTION' && pendingAction.abilityId === 'NECROMANCER_SACRIFICE') sacBtn.style.border = '2px solid white';
       sacBtn.onclick = () => { pendingAction = {kind:'FREE_ACTION', abilityId:'NECROMANCER_SACRIFICE'}; syncGameState(); };
       actionbar.appendChild(sacBtn);
     }
     
     const moveBtn = document.createElement('button');
     moveBtn.textContent = 'Move / Attack';
     if (!pendingAction) moveBtn.style.border = '2px solid white';
     moveBtn.onclick = () => { pendingAction = null; syncGameState(); };
     actionbar.appendChild(moveBtn);
  }
}

advanceBtn.onclick = () => {
  if (state.phase === 'HERO_FREE_ACTION') {
    state.phase = 'DICE_ROLL';
    syncGameState();
  } else if (state.phase === 'DICE_ROLL') {
    controller.rollCommandDice();
    syncGameState();
  } else if (state.phase === 'DICE_ASSIGNMENT') {
    controller.endTurn();
    window.skippedFreeAction = false;
    syncGameState();
  }
  uiState = 'IDLE';
  selectedDieId = null;
  pendingAction = null;
  selectedUnitId = null;
  syncGameState();
};

skipFreeActionBtn.onclick = () => {
  window.skippedFreeAction = true;
  syncGameState();
};

function flashSelect(view: EntityView) {
  const mat = view.mesh.material as THREE.MeshStandardMaterial;
  const orig = mat.emissive.getHex();
  mat.emissive.setHex(0x444466);
  setTimeout(() => mat.emissive.setHex(orig), 250);
}

// ----------------------------------------------------
// BFS PATHFINDING
// ----------------------------------------------------
function bfsPath(start: {x:number, y:number}, end: {x:number, y:number}): {x:number, y:number}[] {
  const queue = [{x: start.x, y: start.y, path: [] as {x:number,y:number}[]}];
  const visited = new Set<string>();
  visited.add(`${start.x},${start.y}`);

  const dirs = [{x:-1,y:-1},{x:0,y:-1},{x:1,y:-1},{x:-1,y:0},{x:1,y:0},{x:-1,y:1},{x:0,y:1},{x:1,y:1}];

  while(queue.length > 0) {
    const curr = queue.shift()!;
    if (curr.x === end.x && curr.y === end.y) {
      return curr.path;
    }
    for (const d of dirs) {
      const nx = curr.x + d.x;
      const ny = curr.y + d.y;
      if (nx < 0 || nx >= state.board.width || ny < 0 || ny >= state.board.height) continue;
      const key = `${nx},${ny}`;
      
      if (!visited.has(key)) {
        visited.add(key);
        const tile = state.board.tiles[ny * state.board.width + nx];
        if (tile.type === 'WALL' || tile.tempEffect?.treatAsType === 'WALL') continue;
        
        const u = getUnitAt(state, nx, ny) || getHeroAt(state, nx, ny);
        if (u && (nx !== end.x || ny !== end.y)) {
           // blocked by any unit if intermediate
           continue;
        }

        queue.push({x: nx, y: ny, path: [...curr.path, {x:nx, y:ny}]});
      }
    }
  }
  return [];
}


// ----------------------------------------------------
// INPUT HANDLING
// ----------------------------------------------------
const raycastPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

let lastHoveredGridX: number | null = null;
let lastHoveredGridY: number | null = null;
let lastHoveredEntityId: string | null = null;
const TOOLTIP_OFFSET_X = 16;
const TOOLTIP_OFFSET_Y = 16;

const hoverMat = new THREE.MeshBasicMaterial({ color: 0x66ccff, transparent: true, opacity: 0.25 });
const hoverGeo = new THREE.BoxGeometry(TILE_SIZE, TILE_HEIGHT * 1.02, TILE_SIZE);
const hoverMesh = new THREE.Mesh(hoverGeo, hoverMat);
hoverMesh.visible = false;
scene.add(hoverMesh);

function updateTooltipContent(entity: Unit | Hero): void {
  const isHero = !!(entity as Hero).heroClass;
  ttName.textContent = isHero ? (entity as Hero).heroClass : (entity as Unit).unitClass;
  ttHp.textContent = `${entity.hp} / ${entity.maxHp}`;
  ttAtk.textContent = String(entity.atk);
  ttDef.textContent = String(entity.def);
}

function hideTooltip(): void {
  tooltipEl.classList.remove('visible');
  lastHoveredGridX = null;
  lastHoveredGridY = null;
  lastHoveredEntityId = null;
}

renderer.domElement.addEventListener('pointermove', (e: MouseEvent) => {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hit = new THREE.Vector3();

  if (raycaster.ray.intersectPlane(raycastPlane, hit)) {
    const { gridX, gridY } = worldToGrid(hit.x, hit.z);

    if (gridX >= 0 && gridX < state.board.width && gridY >= 0 && gridY < state.board.height) {
      const { x, z } = gridToWorld(gridX, gridY);
      hoverMesh.position.set(x, -TILE_HEIGHT / 2, z);
      hoverMesh.visible = true;

      const tileChanged = gridX !== lastHoveredGridX || gridY !== lastHoveredGridY;
      if (tileChanged) {
        const hoveredEntity = getUnitAt(state, gridX, gridY) || getHeroAt(state, gridX, gridY);

        if (hoveredEntity) {
          if (hoveredEntity.id !== lastHoveredEntityId) {
            updateTooltipContent(hoveredEntity);
            lastHoveredEntityId = hoveredEntity.id;
          }
          tooltipEl.classList.add('visible');
        } else {
          hideTooltip();
        }
        lastHoveredGridX = gridX;
        lastHoveredGridY = gridY;
      }

      if (tooltipEl.classList.contains('visible')) {
        tooltipEl.style.transform = `translate(${e.clientX - rect.left + TOOLTIP_OFFSET_X}px, ${e.clientY - rect.top + TOOLTIP_OFFSET_Y}px)`;
      }
      return;
    }
  }

  hoverMesh.visible = false;
  hideTooltip();
});

function spawnDamagePopup(worldPos: THREE.Vector3, text: string, color: number) {
  const screen = worldToScreen(worldPos);
  const div = document.createElement('div');
  div.className = 'damage-popup';
  div.textContent = text;
  div.style.position = 'absolute';
  div.style.left = `${screen.x}px`;
  div.style.top = `${screen.y}px`;
  div.style.pointerEvents = 'none';
  div.style.fontWeight = 'bold';
  div.style.fontSize = '24px';
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

renderer.domElement.addEventListener('click', (e: MouseEvent) => {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hit = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(raycastPlane, hit)) return;
  const { gridX, gridY } = worldToGrid(hit.x, hit.z);
  if (gridX < 0 || gridX >= state.board.width || gridY < 0 || gridY >= state.board.height) return;

  const clickedEntity = getUnitAt(state, gridX, gridY) || getHeroAt(state, gridX, gridY);

  if (state.phase === 'UPKEEP') {
     if (currentUpkeepShortfall.length > 0 && clickedEntity && currentUpkeepShortfall.includes(clickedEntity.id)) {
        const res = controller.resolveUpkeepShortfall(state.activePlayerId, clickedEntity.id);
        if (!res.ok) spawnDamagePopup(hit, res.reason || 'Error', 0xff6666);
        syncGameState();
     }
     return;
  }

  if (state.phase === 'HERO_FREE_ACTION') {
    const activeHero = state.heroes.find(h => h.ownerId === state.activePlayerId)!;
    if (!activeHero.freeActionUsed && !window.skippedFreeAction) {
       if (uiState === 'IDLE' && clickedEntity?.id === activeHero.id) {
         uiState = 'FREE_ACTION_TARGETING';
         pendingAction = null;
         syncGameState();
         return;
       }
       
       if (uiState === 'FREE_ACTION_TARGETING') {
         let res;
         if (pendingAction?.kind === 'FREE_ACTION' && pendingAction.abilityId === 'NECROMANCER_SHADOWSTEP') {
            res = controller.castShadowstep(activeHero.id, gridX, gridY);
         } else if (pendingAction?.kind === 'FREE_ACTION' && pendingAction.abilityId === 'NECROMANCER_SACRIFICE') {
            if (clickedEntity && clickedEntity.ownerId === activeHero.ownerId && (clickedEntity as Unit).unitClass) {
               res = controller.castSacrifice(activeHero.id, clickedEntity.id);
            }
         } else {
            res = controller.moveHero(activeHero.id, gridX, gridY);
         }
         
         if (res && !res.ok) spawnDamagePopup(hit, res.reason || 'Error', 0xff6666);
         
         uiState = 'IDLE';
         pendingAction = null;
         syncGameState();
         return;
       }
    }
  }

  if (state.phase === 'DICE_ASSIGNMENT') {
    if (uiState === 'DIE_SELECTED' && selectedDieId) {
       if (!pendingAction) {
          if (clickedEntity && clickedEntity.ownerId === state.activePlayerId && (clickedEntity as Unit).unitClass) {
             selectedUnitId = clickedEntity.id;
             const view = entityViews.get(selectedUnitId);
             if (view) flashSelect(view);
             syncGameState();
             return;
          }
          if (selectedUnitId) {
             const u = state.units.find(un => un.id === selectedUnitId);
             if (u) {
                 const path = bfsPath({x: u.x, y: u.y}, {x: gridX, y: gridY});
                 const attackTarget = (clickedEntity && clickedEntity.ownerId !== state.activePlayerId) ? clickedEntity.id : undefined;
                 controller.assignDieToUnit(selectedDieId, selectedUnitId);
                 const res = controller.resolveUnitActivation(selectedUnitId, path, attackTarget);
                 if (!res.ok) spawnDamagePopup(hit, res.reason || 'Error', 0xff6666);
             }
             uiState = 'IDLE'; selectedDieId = null; selectedUnitId = null;
             syncGameState();
             return;
          }
       }
    }

    if (uiState === 'SPELL_TARGETING' && pendingAction) {
       let res;
       if (pendingAction.kind === 'SPAWN') {
          res = controller.assignDieToSpawn(selectedDieId!, pendingAction.unitClass, {x: gridX, y: gridY});
       } else if (pendingAction.kind === 'UPGRADE_PROPERTY') {
          res = controller.assignDieToUpgrade(selectedDieId!, pendingAction.propertyType, {x: gridX, y: gridY});
       } else if (pendingAction.kind === 'SPELL') {
          let target: string | {x:number, y:number} = {x: gridX, y: gridY};
          if (pendingAction.abilityId !== 'ENGINEER_FORTIFY' && clickedEntity) {
             target = clickedEntity.id;
          }
          res = controller.assignDieToSpell(selectedDieId!, pendingAction.abilityId, target);
       }
       if (res && !res.ok) spawnDamagePopup(hit, res.reason || 'Error', 0xff6666);
       
       uiState = 'IDLE';
       selectedDieId = null;
       pendingAction = null;
       syncGameState();
       return;
    }
  }
});

const clock = new THREE.Clock();
const hoverSpeed = 1.5;
const hoverAmplitude = 0.12;
const underlingHoverSpeed = 2.0;
const underlingHoverAmplitude = 0.04;

function animate() {
  requestAnimationFrame(animate);
  const t = clock.getElapsedTime();

  for (const view of entityViews.values()) {
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

  controls.update();
  renderer.render(scene, camera);
}

animate();
syncGameState();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
