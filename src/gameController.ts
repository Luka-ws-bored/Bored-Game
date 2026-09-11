// ═══════════════════════════════════════════════════════════════
// gameController.ts — Definitive Ruleset Implementation
// ═══════════════════════════════════════════════════════════════

import {
  type GameState, type Player, type Hero, type Unit, type Tile, type Die,
  type UnitClass, type PropertyType, type AbilityId, type HeroClass,
  type ActionTargetType,
  chebyshevDistance, computeDamage,
  PROPERTY_STATS, ENGINEER_TOWER_ADJACENT_DEF_BONUS, WARLORD_SHRINE_UPKEEP_REDUCTION, NECROMANCER_ALTAR_SIPHON_HEAL,
  WARLORD_RALLY_THRESHOLD, WARLORD_RALLY_MOVE_TILES, WARLORD_EXECUTE_THRESHOLD, WARLORD_EXECUTE_HP_CEILING,
  ENGINEER_FORTIFY_THRESHOLD, ENGINEER_OVERCLOCK_THRESHOLD, ENGINEER_OVERCLOCK_ATK_BONUS, ENGINEER_OVERCLOCK_RECOIL_DAMAGE,
  HERO_SACRIFICE_HP_GAIN, ESSENCE_PER_NORMAL_TILE, UPKEEP_COST, VOID_ZONE_DAMAGE, VOID_ZONE_START_TURN, VOID_ZONE_SHRINK_INTERVAL,
  SPAWN_THRESHOLDS, SPAWN_COSTS, UNIT_CLASS_OWNER, MAX_UNITS_PER_PLAYER, SPELL_RANGE, UNIT_STATS
} from './gameState';

export interface ActionResult {
  ok: boolean;
  reason?: string;
}

export interface CombatResult {
  attackerDamageDealt: number;
  defenderDamageDealt: number;
  attackerKilled: boolean;
  defenderKilled: boolean;
  splashResults?: { unitId: string; damage: number }[];
}

export class GameController {
  constructor(private state: GameState) {}

  // ─── HELPERS ───
  private getTile(x: number, y: number): Tile | undefined {
    if (x < 0 || x >= this.state.board.width || y < 0 || y >= this.state.board.height) return undefined;
    return this.state.board.tiles[y * this.state.board.width + x];
  }

  private getUnitAt(x: number, y: number): Unit | undefined {
    return this.state.units.find(u => u.x === x && u.y === y);
  }

  private getHeroAt(x: number, y: number): Hero | undefined {
    return this.state.heroes.find(h => h.x === x && h.y === y);
  }

  private getPlayer(id: string): Player | undefined {
    return this.state.players.find(p => p.id === id);
  }

  private killUnit(unitId: string): void {
    const unitIndex = this.state.units.findIndex(u => u.id === unitId);
    if (unitIndex !== -1) {
      const unit = this.state.units[unitIndex];
      this.state.units.splice(unitIndex, 1);
      const owner = this.getPlayer(unit.ownerId);
      if (owner) owner.unitIds = owner.unitIds.filter(id => id !== unitId);
      
      const tile = this.getTile(unit.x, unit.y);
      if (tile) tile.hasCorpse = true;
      
      this.triggerSoulSiphonIfApplicable(unit.x, unit.y);
    }
  }

  // ═══ PHASE 1: ESSENCE_GENERATION ═══
  public runEssenceGeneration(playerId: string): void {
    const player = this.getPlayer(playerId);
    if (!player) return;

    for (const coord of player.ownedTileCoords) {
      const tile = this.getTile(coord.x, coord.y);
      if (!tile) continue;
      
      if (tile.type === 'NORMAL') {
        player.essence += ESSENCE_PER_NORMAL_TILE;
      }
      if (tile.property !== 'NONE' && tile.propertyOwnerId === playerId) {
        player.essence += PROPERTY_STATS[tile.property].essenceBonus;
      }
    }
  }

  // ═══ PHASE 2: UPKEEP ═══
  public runUpkeep(playerId: string): { unpaidUnitIds: string[] } {
    const player = this.getPlayer(playerId);
    if (!player) return { unpaidUnitIds: [] };

    const unpaidUnitIds: string[] = [];
    for (const unitId of player.unitIds) {
      const unit = this.state.units.find(u => u.id === unitId);
      if (!unit || !unit.isUpkeepUnit) continue;

      const cost = this.getEffectiveUpkeepCost(unit);
      if (player.essence >= cost) {
        player.essence -= cost;
      } else {
        unpaidUnitIds.push(unitId);
      }
    }
    return { unpaidUnitIds };
  }

  public resolveUpkeepShortfall(playerId: string, unitIdToRemove: string): void {
    const player = this.getPlayer(playerId);
    if (!player) return;
    this.killUnit(unitIdToRemove);
  }

  // ═══ PHASE 3: HERO_FREE_ACTION ═══
  private findPath(start: {x:number, y:number}, end: {x:number, y:number}, maxDist: number): boolean {
    const queue: {x:number, y:number, d:number}[] = [{...start, d:0}];
    const visited = new Set<string>();
    visited.add(`${start.x},${start.y}`);
    
    const dirs = [
      {x: -1, y: -1}, {x: 0, y: -1}, {x: 1, y: -1},
      {x: -1, y:  0},                {x: 1, y:  0},
      {x: -1, y:  1}, {x: 0, y:  1}, {x: 1, y:  1}
    ];

    while (queue.length > 0) {
      const {x, y, d} = queue.shift()!;
      if (x === end.x && y === end.y) return true;
      if (d >= maxDist) continue;

      for (const dir of dirs) {
        const nx = x + dir.x;
        const ny = y + dir.y;
        if (nx < 0 || nx >= this.state.board.width || ny < 0 || ny >= this.state.board.height) continue;
        
        const tile = this.getTile(nx, ny)!;
        if (tile.type === 'WALL' || tile.tempEffect?.treatAsType === 'WALL') continue;
        
        const key = `${nx},${ny}`;
        if (!visited.has(key)) {
          visited.add(key);
          queue.push({x: nx, y: ny, d: d + 1});
        }
      }
    }
    return false;
  }

  public moveHero(heroId: string, toX: number, toY: number): ActionResult {
    const hero = this.state.heroes.find(h => h.id === heroId);
    if (!hero) return { ok: false, reason: 'Hero not found' };
    if (hero.ownerId !== this.state.activePlayerId) return { ok: false, reason: 'Not active player' };
    if (hero.freeActionUsed) return { ok: false, reason: 'Free action already used' };

    const dist = chebyshevDistance({ x: hero.x, y: hero.y }, { x: toX, y: toY });
    if (dist > 4) return { ok: false, reason: 'Out of range' };
    
    const destTile = this.getTile(toX, toY);
    if (!destTile) return { ok: false, reason: 'Invalid destination' };
    if (destTile.type === 'WALL' || destTile.tempEffect?.treatAsType === 'WALL') return { ok: false, reason: 'Destination is a wall' };
    if (this.getHeroAt(toX, toY) || this.getUnitAt(toX, toY)) return { ok: false, reason: 'Destination occupied' };

    if (!this.findPath({x: hero.x, y: hero.y}, {x: toX, y: toY}, 4)) {
      return { ok: false, reason: 'No valid path' };
    }

    hero.x = toX;
    hero.y = toY;
    hero.freeActionUsed = true;
    
    if (destTile.ownerId !== hero.ownerId) {
       this.captureTile(toX, toY, hero.ownerId);
    }
    
    return { ok: true };
  }

  public castShadowstep(heroId: string, toX: number, toY: number): ActionResult {
    const hero = this.state.heroes.find(h => h.id === heroId);
    if (!hero || hero.heroClass !== 'NECROMANCER') return { ok: false, reason: 'Invalid hero' };
    if (hero.ownerId !== this.state.activePlayerId) return { ok: false, reason: 'Not active player' };
    if (hero.freeActionUsed) return { ok: false, reason: 'Free action already used' };

    const dist = chebyshevDistance({ x: hero.x, y: hero.y }, { x: toX, y: toY });
    if (dist > 3) return { ok: false, reason: 'Out of range' };
    
    if (!this.hasLineOfSight({x: hero.x, y: hero.y}, {x: toX, y: toY})) {
      return { ok: false, reason: 'Line of sight blocked' };
    }

    const destTile = this.getTile(toX, toY);
    if (!destTile || destTile.type === 'WALL' || destTile.tempEffect?.treatAsType === 'WALL') return { ok: false, reason: 'Destination invalid' };
    if (this.getHeroAt(toX, toY) || this.getUnitAt(toX, toY)) return { ok: false, reason: 'Destination occupied' };

    hero.x = toX;
    hero.y = toY;
    hero.freeActionUsed = true;
    hero.abilitiesUsedThisTurn.push('NECROMANCER_SHADOWSTEP');

    if (destTile.ownerId !== hero.ownerId) {
       this.captureTile(toX, toY, hero.ownerId);
    }
    
    return { ok: true };
  }

  public castSacrifice(heroId: string, targetUnitId: string): ActionResult {
    const hero = this.state.heroes.find(h => h.id === heroId);
    if (!hero || hero.heroClass !== 'NECROMANCER') return { ok: false, reason: 'Invalid hero' };
    if (hero.ownerId !== this.state.activePlayerId) return { ok: false, reason: 'Not active player' };
    if (hero.freeActionUsed) return { ok: false, reason: 'Free action already used' };

    const targetUnit = this.state.units.find(u => u.id === targetUnitId);
    if (!targetUnit) return { ok: false, reason: 'Target not found' };

    if (chebyshevDistance({x: hero.x, y: hero.y}, {x: targetUnit.x, y: targetUnit.y}) !== 1) {
      return { ok: false, reason: 'Target not adjacent' };
    }

    this.killUnit(targetUnit.id);

    hero.hp = Math.min(hero.maxHp, hero.hp + HERO_SACRIFICE_HP_GAIN);
    hero.freeActionUsed = true;
    hero.abilitiesUsedThisTurn.push('NECROMANCER_SACRIFICE');

    return { ok: true };
  }

  public captureTile(x: number, y: number, byPlayerId: string): ActionResult {
    const tile = this.getTile(x, y);
    if (!tile) return { ok: false, reason: 'Tile not found' };
    const player = this.getPlayer(byPlayerId);
    if (!player) return { ok: false, reason: 'Player not found' };

    if (tile.ownerId && tile.ownerId !== byPlayerId) {
        const oldOwner = this.getPlayer(tile.ownerId);
        if (oldOwner) {
            oldOwner.ownedTileCoords = oldOwner.ownedTileCoords.filter(c => c.x !== x || c.y !== y);
        }
    }

    tile.ownerId = byPlayerId;
    const hero = this.state.heroes.find(h => h.id === player.heroId);
    if (hero) {
        tile.infusionTag = { heroId: hero.id, heroClass: hero.heroClass };
    }
    
    if (!player.ownedTileCoords.some(c => c.x === x && c.y === y)) {
        player.ownedTileCoords.push({x, y});
    }
    
    return { ok: true };
  }

  // ═══ PHASE 4: DICE_ROLL ═══
  public rollCommandDice(): Die[] {
    const dice: Die[] = [];
    for (let i = 0; i < 3; i++) {
      dice.push({
        id: `die-${this.state.turnNumber}-${i}`,
        faceValue: Math.floor(Math.random() * 6) + 1,
        assignedTo: { targetType: 'UNASSIGNED', targetId: null, abilityId: null, spawnClass: null, propertyType: null, targetTile: null },
        consumed: false
      });
    }
    this.state.currentDiceRoll = dice;
    this.state.phase = 'DICE_ASSIGNMENT';
    return dice;
  }

  // ═══ PHASE 5/6: DICE_ASSIGNMENT ═══
  public assignDieToUnit(dieId: string, unitId: string): ActionResult {
    const die = this.state.currentDiceRoll.find(d => d.id === dieId);
    if (!die || die.consumed) return { ok: false, reason: 'Die invalid or consumed' };
    
    const unit = this.state.units.find(u => u.id === unitId);
    if (!unit || unit.ownerId !== this.state.activePlayerId) return { ok: false, reason: 'Invalid unit' };
    
    if (unit.activation.hasActedThisTurn) return { ok: false, reason: 'Unit already acted' };

    unit.activation.diePipsAssigned = die.faceValue;
    unit.activation.pipsRemaining = die.faceValue;
    
    die.assignedTo = { targetType: 'UNIT', targetId: unitId, abilityId: null, spawnClass: null, propertyType: null, targetTile: null };
    die.consumed = true;
    
    return { ok: true };
  }

  public resolveUnitActivation(
    unitId: string,
    path: { x: number; y: number }[],
    attackTargetId?: string
  ): ActionResult {
    const unit = this.state.units.find(u => u.id === unitId);
    if (!unit || unit.ownerId !== this.state.activePlayerId) return { ok: false, reason: 'Invalid unit' };
    if (unit.activation.hasActedThisTurn || unit.activation.pipsRemaining <= 0) return { ok: false, reason: 'Unit cannot act' };

    // Strict Path validation
    if (path.length > 0) {
      if (path.length > unit.activation.pipsRemaining) return { ok: false, reason: 'Not enough pips for path' };
      if (path.length > unit.moveRange) return { ok: false, reason: 'Exceeds move range' };
      
      let currX = unit.x;
      let currY = unit.y;
      
      for (let i = 0; i < path.length; i++) {
        const step = path[i];
        if (chebyshevDistance({x: currX, y: currY}, step) !== 1) {
          return { ok: false, reason: 'Path steps must be adjacent' };
        }
        const tile = this.getTile(step.x, step.y);
        if (!tile || tile.type === 'WALL' || tile.tempEffect?.treatAsType === 'WALL') {
          return { ok: false, reason: 'Path blocked by wall or fortify' };
        }
        
        const occupantUnit = this.getUnitAt(step.x, step.y);
        const occupantHero = this.getHeroAt(step.x, step.y);
        
        if (i < path.length - 1) {
          if (occupantUnit || occupantHero) {
             return { ok: false, reason: 'Path step blocked by unit' };
          }
        } else {
          // Final step
          if (occupantUnit || occupantHero) {
             return { ok: false, reason: 'Destination occupied' };
          }
        }
        
        currX = step.x;
        currY = step.y;
      }
      
      unit.x = currX;
      unit.y = currY;
      unit.activation.pipsRemaining -= path.length;
      
      const destTile = this.getTile(unit.x, unit.y);
      if (destTile && destTile.ownerId !== unit.ownerId && unit.canCaptureTerritory) {
        this.captureTile(unit.x, unit.y, unit.ownerId);
      }
    }

    if (attackTargetId) {
      if (!unit.canAttack) return { ok: false, reason: 'Unit cannot attack' };
      if (unit.activation.pipsRemaining < 2) return { ok: false, reason: 'Not enough pips to attack (needs 2)' };
      
      let targetEntity: Unit | Hero | undefined = this.state.units.find(u => u.id === attackTargetId);
      if (!targetEntity) {
        targetEntity = this.state.heroes.find(h => h.id === attackTargetId);
      }
      
      if (!targetEntity) return { ok: false, reason: 'Target not found' };
      if (targetEntity.ownerId === unit.ownerId) return { ok: false, reason: 'Cannot attack friendly' };

      const dist = chebyshevDistance({x: unit.x, y: unit.y}, {x: targetEntity.x, y: targetEntity.y});
      
      if (unit.unitClass === 'SNIPER') {
        if (dist > unit.attackRange) return { ok: false, reason: 'Out of range' };
        if (!this.hasLineOfSight({x: unit.x, y: unit.y}, {x: targetEntity.x, y: targetEntity.y})) {
          return { ok: false, reason: 'Line of sight blocked' };
        }
      } else {
        if (dist > unit.attackRange) return { ok: false, reason: 'Out of range (must be adjacent)' };
      }

      this.resolveCombat(unit.id, attackTargetId);
      unit.activation.pipsRemaining = 0;
    }

    if (unit.activation.pipsRemaining <= 0 || (!path.length && !attackTargetId)) {
      unit.activation.hasActedThisTurn = true;
    }

    return { ok: true };
  }

  public assignDieToSpell(
    dieId: string,
    abilityId: AbilityId,
    target: string | { x: number; y: number }
  ): ActionResult {
    const die = this.state.currentDiceRoll.find(d => d.id === dieId);
    if (!die || die.consumed) return { ok: false, reason: 'Die invalid or consumed' };

    const hero = this.state.heroes.find(h => h.ownerId === this.state.activePlayerId);
    if (!hero) return { ok: false, reason: 'Hero not found' };

    let threshold = 1;
    let requiredRange = SPELL_RANGE;
    let isExecute = false;

    switch (abilityId) {
      case 'WARLORD_RALLY': threshold = WARLORD_RALLY_THRESHOLD; break;
      case 'WARLORD_EXECUTE': threshold = WARLORD_EXECUTE_THRESHOLD; requiredRange = 1; isExecute = true; break;
      case 'ENGINEER_FORTIFY': threshold = ENGINEER_FORTIFY_THRESHOLD; break;
      case 'ENGINEER_OVERCLOCK': threshold = ENGINEER_OVERCLOCK_THRESHOLD; break;
    }

    if (die.faceValue < threshold) return { ok: false, reason: 'Die value too low for spell' };

    let targetCoords = { x: 0, y: 0 };
    if (typeof target === 'string') {
       let targetEntity: Unit | Hero | undefined = this.state.units.find(u => u.id === target);
       if (!targetEntity) targetEntity = this.state.heroes.find(h => h.id === target);
       if (!targetEntity) return { ok: false, reason: 'Target entity not found' };
       
       if (isExecute && targetEntity.hp > WARLORD_EXECUTE_HP_CEILING) {
         return { ok: false, reason: 'Execute target HP above ceiling' };
       }
       targetCoords = { x: targetEntity.x, y: targetEntity.y };
    } else {
       targetCoords = target;
    }

    const dist = chebyshevDistance({x: hero.x, y: hero.y}, targetCoords);
    if (dist > requiredRange) return { ok: false, reason: 'Target out of spell range' };
    
    if (!this.hasLineOfSight({x: hero.x, y: hero.y}, targetCoords)) {
      return { ok: false, reason: 'Line of sight blocked' };
    }

    const result = this.applyAbilityEffect(abilityId, hero.id, target, die.faceValue);
    if (result.ok) {
      die.consumed = true;
      die.assignedTo = { targetType: 'HERO_SPELL', targetId: typeof target === 'string' ? target : null, abilityId, spawnClass: null, propertyType: null, targetTile: typeof target === 'string' ? null : target };
    }
    return result;
  }

  public assignDieToSpawn(
    dieId: string,
    unitClass: UnitClass,
    spawnTile: { x: number; y: number }
  ): ActionResult {
    const die = this.state.currentDiceRoll.find(d => d.id === dieId);
    if (!die || die.consumed) return { ok: false, reason: 'Die invalid' };

    const hero = this.state.heroes.find(h => h.ownerId === this.state.activePlayerId);
    if (!hero) return { ok: false, reason: 'Hero not found' };
    
    if (UNIT_CLASS_OWNER[unitClass] !== hero.heroClass) return { ok: false, reason: 'Class mismatch' };
    if (die.faceValue < SPAWN_THRESHOLDS[unitClass]) return { ok: false, reason: 'Die too low' };

    const player = this.getPlayer(this.state.activePlayerId)!;
    if (player.unitIds.length >= MAX_UNITS_PER_PLAYER) return { ok: false, reason: 'Unit cap reached' };

    let nearOwned = false;
    for (const owned of player.ownedTileCoords) {
      if (chebyshevDistance(owned, spawnTile) <= 1) {
        nearOwned = true;
        break;
      }
    }
    if (!nearOwned) return { ok: false, reason: 'Must spawn near owned territory' };

    const destTile = this.getTile(spawnTile.x, spawnTile.y);
    if (!destTile || destTile.type === 'WALL' || destTile.tempEffect?.treatAsType === 'WALL') return { ok: false, reason: 'Invalid spawn tile' };
    if (this.getUnitAt(spawnTile.x, spawnTile.y) || this.getHeroAt(spawnTile.x, spawnTile.y)) return { ok: false, reason: 'Tile occupied' };

    const cost = SPAWN_COSTS[unitClass];
    if (player.essence < cost.essence) return { ok: false, reason: 'Not enough essence' };
    if (cost.heroHp > 0) {
      if (!this.canAffordHpCost(hero.id, cost.heroHp)) return { ok: false, reason: 'Not enough HP' };
      hero.hp -= cost.heroHp;
    }
    player.essence -= cost.essence;

    const stats = UNIT_STATS[unitClass];
    const newUnit: Unit = {
      id: `unit-${this.state.activePlayerId}-${this.state.turnNumber}-${Math.random().toString(36).substring(2, 7)}`,
      ownerId: this.state.activePlayerId,
      unitClass,
      hp: stats.hp,
      maxHp: stats.hp,
      atk: stats.atk,
      def: stats.def,
      moveRange: stats.moveRange,
      attackRange: stats.attackRange,
      x: spawnTile.x,
      y: spawnTile.y,
      activation: { diePipsAssigned: null, pipsRemaining: 0, hasActedThisTurn: true },
      tempEffects: [],
      scheduledEffects: [],
      canAttack: stats.attackRange > 0,
      canCaptureTerritory: true,
      isUpkeepUnit: !!UPKEEP_COST[unitClass]
    };

    this.state.units.push(newUnit);
    player.unitIds.push(newUnit.id);
    
    die.consumed = true;
    die.assignedTo = { targetType: 'SPAWN', targetId: newUnit.id, abilityId: null, spawnClass: unitClass, propertyType: null, targetTile: spawnTile };

    return { ok: true };
  }

  public assignDieToUpgrade(
    dieId: string,
    propertyType: PropertyType,
    tileCoord: { x: number; y: number }
  ): ActionResult {
    const die = this.state.currentDiceRoll.find(d => d.id === dieId);
    if (!die || die.consumed) return { ok: false, reason: 'Die invalid' };

    const hero = this.state.heroes.find(h => h.ownerId === this.state.activePlayerId);
    if (!hero) return { ok: false, reason: 'Hero not found' };

    if (propertyType === 'NONE') return { ok: false, reason: 'Invalid property' };
    const stats = PROPERTY_STATS[propertyType as Exclude<PropertyType, 'NONE'>];
    
    if (die.faceValue < stats.buildThreshold) return { ok: false, reason: 'Die too low' };
    
    const tile = this.getTile(tileCoord.x, tileCoord.y);
    if (!tile) return { ok: false, reason: 'Tile not found' };
    if (tile.ownerId !== this.state.activePlayerId) return { ok: false, reason: 'Must own territory to upgrade' };
    
    let match = false;
    if (propertyType === 'WARLORD_SHRINE' && hero.heroClass === 'WARLORD') match = true;
    if (propertyType === 'ENGINEER_TOWER' && hero.heroClass === 'ENGINEER') match = true;
    if (propertyType === 'NECROMANCER_ALTAR' && hero.heroClass === 'NECROMANCER') match = true;
    if (!match) return { ok: false, reason: 'Property class mismatch' };

    const player = this.getPlayer(this.state.activePlayerId)!;
    if (player.essence < stats.essenceCost) return { ok: false, reason: 'Not enough essence' };

    player.essence -= stats.essenceCost;
    tile.property = propertyType;
    tile.propertyOwnerId = this.state.activePlayerId;

    die.consumed = true;
    die.assignedTo = { targetType: 'UPGRADE_PROPERTY', targetId: null, abilityId: null, spawnClass: null, propertyType, targetTile: tileCoord };

    return { ok: true };
  }

  // ─── Ability dispatch ───
  private applyAbilityEffect(
    abilityId: AbilityId,
    casterId: string,
    target: string | { x: number; y: number },
    dieValue: number
  ): ActionResult {
    let targetUnit = typeof target === 'string' ? this.state.units.find(u => u.id === target) : undefined;
    let targetHero = typeof target === 'string' ? this.state.heroes.find(h => h.id === target) : undefined;
    
    switch (abilityId) {
      case 'WARLORD_BLESS':
        if (!targetUnit || targetUnit.ownerId !== this.state.activePlayerId) return { ok: false, reason: 'Target must be friendly unit' };
        if (targetUnit.unitClass !== 'MERCENARY' && targetUnit.unitClass !== 'SNIPER') return { ok: false, reason: 'Must target Merc/Sniper' };
        targetUnit.tempEffects.push({ stat: 'ATK', amount: dieValue, expiresOn: 'END_OF_TURN', sourceAbility: abilityId });
        break;

      case 'WARLORD_CURSE':
        if (!targetUnit || targetUnit.ownerId === this.state.activePlayerId) return { ok: false, reason: 'Target must be enemy unit' };
        targetUnit.tempEffects.push({ stat: 'MOVE', amount: -dieValue, expiresOn: 'END_OF_TURN', sourceAbility: abilityId });
        break;

      case 'WARLORD_RALLY':
        if (!targetUnit || targetUnit.ownerId !== this.state.activePlayerId) return { ok: false, reason: 'Target must be friendly unit' };
        targetUnit.activation.pipsRemaining += WARLORD_RALLY_MOVE_TILES;
        targetUnit.activation.hasActedThisTurn = false;
        break;

      case 'WARLORD_EXECUTE':
        if (!targetUnit || targetUnit.ownerId === this.state.activePlayerId) return { ok: false, reason: 'Target must be enemy unit' };
        this.killUnit(targetUnit.id);
        break;

      case 'ENGINEER_BLESS':
        if (!targetUnit || targetUnit.ownerId !== this.state.activePlayerId || targetUnit.unitClass !== 'CONSTRUCT') return { ok: false, reason: 'Target must be friendly Construct' };
        targetUnit.tempEffects.push({ stat: 'DEF', amount: dieValue, expiresOn: 'NEXT_DAMAGE', sourceAbility: abilityId });
        break;

      case 'ENGINEER_CURSE':
        if (!targetUnit || targetUnit.ownerId === this.state.activePlayerId) return { ok: false, reason: 'Target must be enemy unit' };
        targetUnit.tempEffects.push({ stat: 'DEF', amount: -dieValue, expiresOn: 'END_OF_TURN', sourceAbility: abilityId });
        break;

      case 'ENGINEER_FORTIFY':
        if (typeof target === 'string') return { ok: false, reason: 'Target must be a tile' };
        const tile = this.getTile(target.x, target.y);
        if (!tile || tile.ownerId !== this.state.activePlayerId || tile.type !== 'NORMAL') return { ok: false, reason: 'Target must be owned NORMAL tile' };
        tile.tempEffect = { treatAsType: 'WALL', expiresOnTurnNumber: this.nextTurnNumberForCaster(casterId), sourceAbility: abilityId, casterId };
        break;

      case 'ENGINEER_OVERCLOCK':
        if (!targetUnit || targetUnit.ownerId !== this.state.activePlayerId || targetUnit.unitClass !== 'CONSTRUCT') return { ok: false, reason: 'Target must be friendly Construct' };
        targetUnit.tempEffects.push({ stat: 'ATK', amount: ENGINEER_OVERCLOCK_ATK_BONUS, expiresOn: 'END_OF_TURN', sourceAbility: abilityId });
        targetUnit.scheduledEffects.push({ kind: 'UNBLOCKABLE_DAMAGE', amount: ENGINEER_OVERCLOCK_RECOIL_DAMAGE, resolvesAtPhase: 'END_TURN', sourceAbility: abilityId });
        break;

      case 'NECROMANCER_BLESS':
        if (!targetUnit) return { ok: false, reason: 'Target must be unit' };
        targetUnit.tempEffects.push({ stat: 'HP', amount: dieValue, expiresOn: 'END_OF_TURN', sourceAbility: abilityId });
        break;

      case 'NECROMANCER_CURSE':
        const enemyEntity = targetUnit || targetHero;
        if (!enemyEntity || enemyEntity.ownerId === this.state.activePlayerId) return { ok: false, reason: 'Target must be enemy unit or hero' };
        enemyEntity.hp -= dieValue;
        if (enemyEntity.hp <= 0) {
            if (targetUnit) this.killUnit(targetUnit.id);
            else this.checkWinCondition();
        }
        break;
    }
    return { ok: true };
  }

  // ═══ COMBAT ═══
  private resolveCombat(attackerId: string, defenderId: string): CombatResult {
    let attackerUnit = this.state.units.find(u => u.id === attackerId);
    let defenderUnit = this.state.units.find(u => u.id === defenderId);
    let attackerHero = this.state.heroes.find(h => h.id === attackerId);
    let defenderHero = this.state.heroes.find(h => h.id === defenderId);

    const attacker = attackerUnit || attackerHero;
    const defender = defenderUnit || defenderHero;
    if (!attacker || !defender) return { attackerDamageDealt: 0, defenderDamageDealt: 0, attackerKilled: false, defenderKilled: false };

    let aAtk = attacker.atk + attacker.tempEffects.filter(e => e.stat === 'ATK').reduce((sum, e) => sum + e.amount, 0);
    let dAtk = defender.atk + defender.tempEffects.filter(e => e.stat === 'ATK').reduce((sum, e) => sum + e.amount, 0);
    
    let aDef = attacker.def + attacker.tempEffects.filter(e => e.stat === 'DEF').reduce((sum, e) => sum + e.amount, 0);
    const aTile = this.getTile(attacker.x, attacker.y);
    if (aTile) aDef += this.computeTileDefenseBonus(aTile);

    let dDef = defender.def + defender.tempEffects.filter(e => e.stat === 'DEF').reduce((sum, e) => sum + e.amount, 0);
    const dTile = this.getTile(defender.x, defender.y);
    if (dTile) dDef += this.computeTileDefenseBonus(dTile);

    const aDmg = computeDamage(aAtk, dDef);
    let dDmg = 0;
    
    const isSniper = attackerUnit && attackerUnit.unitClass === 'SNIPER';
    if (!isSniper) {
      dDmg = computeDamage(dAtk, aDef);
    }

    defender.hp -= aDmg;
    attacker.hp -= dDmg;

    // Sniper Splash
    const splashResults: { unitId: string; damage: number }[] = [];
    if (isSniper) {
      const dirs = [{x: -1, y: 0}, {x: 1, y: 0}, {x: 0, y: -1}, {x: 0, y: 1}];
      for (const dir of dirs) {
        const sx = defender.x + dir.x;
        const sy = defender.y + dir.y;
        const sUnit = this.getUnitAt(sx, sy);
        if (sUnit) {
           sUnit.hp -= 1;
           splashResults.push({ unitId: sUnit.id, damage: 1 });
        }
        const sHero = this.getHeroAt(sx, sy);
        if (sHero) {
           sHero.hp -= 1;
           splashResults.push({ unitId: sHero.id, damage: 1 });
        }
      }
    }

    attacker.tempEffects = attacker.tempEffects.filter(e => e.expiresOn !== 'NEXT_DAMAGE');
    defender.tempEffects = defender.tempEffects.filter(e => e.expiresOn !== 'NEXT_DAMAGE');

    const dKilled = defender.hp <= 0;
    const aKilled = attacker.hp <= 0;

    if (dKilled && defenderUnit) this.killUnit(defenderUnit.id);
    if (aKilled && attackerUnit) this.killUnit(attackerUnit.id);

    if (isSniper) {
      for (const res of splashResults) {
        const unit = this.state.units.find(u => u.id === res.unitId);
        if (unit && unit.hp <= 0) this.killUnit(unit.id);
      }
    }

    this.checkWinCondition();

    return {
      attackerDamageDealt: aDmg,
      defenderDamageDealt: dDmg,
      attackerKilled: aKilled,
      defenderKilled: dKilled,
      splashResults
    };
  }

  private triggerSoulSiphonIfApplicable(deathX: number, deathY: number): void {
    const coords = [
      {x: deathX, y: deathY},
      {x: deathX-1, y: deathY-1}, {x: deathX, y: deathY-1}, {x: deathX+1, y: deathY-1},
      {x: deathX-1, y: deathY},                             {x: deathX+1, y: deathY},
      {x: deathX-1, y: deathY+1}, {x: deathX, y: deathY+1}, {x: deathX+1, y: deathY+1},
    ];

    for (const c of coords) {
      const tile = this.getTile(c.x, c.y);
      if (tile && tile.property === 'NECROMANCER_ALTAR' && tile.propertyOwnerId) {
        const hero = this.state.heroes.find(h => h.ownerId === tile.propertyOwnerId && h.heroClass === 'NECROMANCER');
        if (hero) {
          hero.hp = Math.min(hero.maxHp, hero.hp + NECROMANCER_ALTAR_SIPHON_HEAL);
        }
      }
    }
  }

  // ═══ PROPERTY EFFECT HELPERS ═══
  private computeTileDefenseBonus(tile: Tile): number {
    let bonus = tile.ownerId ? 1 : 0;
    
    let hasTower = false;
    if (tile.ownerId) {
      const coords = [
        {x: tile.x, y: tile.y},
        {x: tile.x-1, y: tile.y-1}, {x: tile.x, y: tile.y-1}, {x: tile.x+1, y: tile.y-1},
        {x: tile.x-1, y: tile.y},                             {x: tile.x+1, y: tile.y},
        {x: tile.x-1, y: tile.y+1}, {x: tile.x, y: tile.y+1}, {x: tile.x+1, y: tile.y+1},
      ];
      for (const c of coords) {
        const adj = this.getTile(c.x, c.y);
        if (adj && adj.property === 'ENGINEER_TOWER' && adj.propertyOwnerId === tile.ownerId) {
          hasTower = true;
          break;
        }
      }
    }
    if (hasTower) bonus += ENGINEER_TOWER_ADJACENT_DEF_BONUS;

    return bonus;
  }

  private getEffectiveUpkeepCost(unit: Unit): number {
    let cost = UPKEEP_COST[unit.unitClass] || 0;
    if (cost === 0) return 0;

    const coords = [
      {x: unit.x, y: unit.y},
      {x: unit.x-1, y: unit.y-1}, {x: unit.x, y: unit.y-1}, {x: unit.x+1, y: unit.y-1},
      {x: unit.x-1, y: unit.y},                             {x: unit.x+1, y: unit.y},
      {x: unit.x-1, y: unit.y+1}, {x: unit.x, y: unit.y+1}, {x: unit.x+1, y: unit.y+1},
    ];
    let hasShrine = false;
    for (const c of coords) {
      const tile = this.getTile(c.x, c.y);
      if (tile && tile.property === 'WARLORD_SHRINE' && tile.propertyOwnerId === unit.ownerId) {
        hasShrine = true;
        break;
      }
    }

    if (hasShrine) cost = Math.max(0, cost - WARLORD_SHRINE_UPKEEP_REDUCTION);
    return cost;
  }

  // ═══ PHASE 7: END_TURN ═══
  private resolveScheduledEffects(playerId: string): void {
    const playerUnits = this.state.units.filter(u => u.ownerId === playerId);
    for (const unit of playerUnits) {
      for (const effect of unit.scheduledEffects) {
        if (effect.resolvesAtPhase === 'END_TURN') {
           unit.hp -= effect.amount;
           if (unit.hp <= 0) {
              this.killUnit(unit.id);
           }
        }
      }
      unit.scheduledEffects = unit.scheduledEffects.filter(e => e.resolvesAtPhase !== 'END_TURN');
    }
  }

  private expireTileTempEffects(): void {
    for (const tile of this.state.board.tiles) {
      if (tile.tempEffect && this.state.turnNumber >= tile.tempEffect.expiresOnTurnNumber) {
        tile.tempEffect = null;
      }
    }
  }

  private runVoidZoneScan(): void {
    if (!this.state.voidZone.active) return;
    
    for (const tile of this.state.board.tiles) {
      if (tile.type === 'VOID') {
        const u = this.getUnitAt(tile.x, tile.y);
        if (u) {
          u.hp -= VOID_ZONE_DAMAGE;
          if (u.hp <= 0) this.killUnit(u.id);
        }
        const h = this.getHeroAt(tile.x, tile.y);
        if (h) {
          h.hp -= VOID_ZONE_DAMAGE;
        }
      }
    }
    this.checkWinCondition();
  }

  private advanceVoidZoneIfDue(): void {
    const turn = this.state.turnNumber;
    if (turn === VOID_ZONE_START_TURN) {
      this.state.voidZone.active = true;
      this.state.voidZone.ringsShrunk = 1;
    } else if (turn > VOID_ZONE_START_TURN && (turn - VOID_ZONE_START_TURN) % VOID_ZONE_SHRINK_INTERVAL === 0) {
      this.state.voidZone.ringsShrunk++;
    }

    if (this.state.voidZone.active) {
      const rings = this.state.voidZone.ringsShrunk;
      for (const tile of this.state.board.tiles) {
         const distToEdgeX = Math.min(tile.x, this.state.board.width - 1 - tile.x);
         const distToEdgeY = Math.min(tile.y, this.state.board.height - 1 - tile.y);
         if (distToEdgeX < rings || distToEdgeY < rings) {
            tile.type = 'VOID';
            tile.ownerId = null;
            tile.infusionTag = null;
            tile.property = 'NONE';
            tile.propertyOwnerId = null;
            tile.hasCorpse = false;
            tile.bomb = null;
            tile.tempEffect = null;
            
            for (const p of this.state.players) {
              p.ownedTileCoords = p.ownedTileCoords.filter(c => c.x !== tile.x || c.y !== tile.y);
            }
         }
      }
    }
  }

  private checkWinCondition(): void {
    const deadHeroes = this.state.heroes.filter(h => h.hp <= 0);
    if (deadHeroes.length > 0) {
      this.state.gameOver = true;
      const aliveHero = this.state.heroes.find(h => h.hp > 0);
      if (aliveHero) {
        this.state.winnerId = aliveHero.ownerId;
      }
    }
  }

  public endTurn(): void {
    this.resolveScheduledEffects(this.state.activePlayerId);
    this.expireTileTempEffects();
    this.advanceVoidZoneIfDue();
    this.runVoidZoneScan();
    this.checkWinCondition();
    if (this.state.gameOver) return;

    this.state.currentDiceRoll = [];

    const playerUnits = this.state.units.filter(u => u.ownerId === this.state.activePlayerId);
    for (const u of playerUnits) {
       u.activation = { diePipsAssigned: null, pipsRemaining: 0, hasActedThisTurn: false };
       u.tempEffects = u.tempEffects.filter(e => e.expiresOn !== 'END_OF_TURN');
    }
    const hero = this.state.heroes.find(h => h.ownerId === this.state.activePlayerId);
    if (hero) {
       hero.freeActionUsed = false;
       hero.abilitiesUsedThisTurn = [];
       hero.tempEffects = hero.tempEffects.filter(e => e.expiresOn !== 'END_OF_TURN');
    }

    const nextPlayerIndex = this.state.players.findIndex(p => p.id === this.state.activePlayerId) === 0 ? 1 : 0;
    if (nextPlayerIndex === 0) {
       this.state.turnNumber++;
    }
    this.state.activePlayerId = this.state.players[nextPlayerIndex].id;
    this.state.phase = 'ESSENCE_GENERATION';
  }

  // ═══ VALIDATION HELPERS ═══
  private canAffordHpCost(heroId: string, hpCost: number): boolean {
    const hero = this.state.heroes.find(h => h.id === heroId);
    if (!hero) return false;
    return (hero.hp - hpCost) >= 1;
  }

  private hasLineOfSight(from: {x:number, y:number}, to: {x:number, y:number}): boolean {
    const dx = Math.abs(to.x - from.x);
    const dy = Math.abs(to.y - from.y);
    const sx = from.x < to.x ? 1 : -1;
    const sy = from.y < to.y ? 1 : -1;
    let err = dx - dy;

    let x = from.x;
    let y = from.y;

    while (true) {
      if (x === to.x && y === to.y) break;
      if (x !== from.x || y !== from.y) {
        const tile = this.getTile(x, y);
        if (tile && (tile.type === 'WALL' || tile.tempEffect?.treatAsType === 'WALL')) {
          return false;
        }
      }
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
    return true;
  }

  private nextTurnNumberForCaster(casterId: string): number {
    return this.state.turnNumber + 2;
  }
}
