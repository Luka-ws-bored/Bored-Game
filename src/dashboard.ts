import {
  type GameState,
  type UnderlingType,
  UNDERLING_STATS,
} from './gameState';
import { type GameController } from './gameController';

export function mountDashboard(
  controller: GameController,
  overlay: HTMLElement,
): void {
  const dash = document.createElement('div');
  dash.className = 'dashboard';
  dash.style.pointerEvents = 'auto';

  const header = document.createElement('div');
  header.className = 'dash-header';

  const playerInfo = document.createElement('div');
  playerInfo.className = 'dash-player-info';

  const phaseInfo = document.createElement('div');
  phaseInfo.className = 'dash-phase-info';

  const cashInfo = document.createElement('div');
  cashInfo.className = 'dash-cash-info';

  header.appendChild(playerInfo);
  header.appendChild(phaseInfo);
  header.appendChild(cashInfo);
  dash.appendChild(header);

  const deploySection = document.createElement('div');
  deploySection.className = 'dash-deploy-section';

  const deployLabel = document.createElement('div');
  deployLabel.className = 'dash-deploy-label';
  deployLabel.textContent = 'Deploy';
  deploySection.appendChild(deployLabel);

  const cardRow = document.createElement('div');
  cardRow.className = 'dash-card-row';

  const cardTypes: UnderlingType[] = ['Standard', 'Mercenary', 'Sniper'];
  const cards: Record<string, HTMLElement> = {};

  for (const t of cardTypes) {
    const card = document.createElement('div');
    card.className = 'deploy-card';
    card.dataset.type = t;

    const name = document.createElement('div');
    name.className = 'card-name';
    name.textContent = t;

    const stats = UNDERLING_STATS[t];
    const cost = document.createElement('div');
    cost.className = 'card-cost';
    cost.textContent = `$${stats.cost}`;

    const statLine = document.createElement('div');
    statLine.className = 'card-stats';
    statLine.textContent = `HP ${stats.hp} · ATK ${stats.atk} · DEF ${stats.def}`;

    card.appendChild(name);
    card.appendChild(cost);
    card.appendChild(statLine);

    card.addEventListener('click', () => {
      controller.setDeployType(t);
    });

    cards[t] = card;
    cardRow.appendChild(card);
  }

  deploySection.appendChild(cardRow);
  dash.appendChild(deploySection);

  const endBtn = document.createElement('button');
  endBtn.className = 'end-phase-btn';
  endBtn.textContent = 'End Phase';
  endBtn.addEventListener('click', () => controller.endPhase());
  dash.appendChild(endBtn);

  overlay.appendChild(dash);

  function refresh(): void {
    const s: GameState = controller.state;
    const player = controller.activePlayer;

    playerInfo.textContent = `${player.name} (${player.commanderType})`;
    playerInfo.style.color = `#${player.color.toString(16).padStart(6, '0')}`;

    phaseInfo.textContent = `Phase: ${s.phase}`;
    phaseInfo.style.color =
      s.phase === 'DEPLOY' ? '#66ccff' : s.phase === 'MOVE' ? '#ffcc44' : '#ff6666';

    cashInfo.textContent = `$${player.cash}`;

    for (const t of cardTypes) {
      const card = cards[t];
      const stats = UNDERLING_STATS[t];
      const affordable = player.cash >= stats.cost;
      card.classList.toggle('disabled', !affordable);
      card.classList.toggle('armed', controller.armedDeployType === t);
    }

    deploySection.style.opacity = s.phase === 'DEPLOY' ? '1' : '0.4';

    endBtn.textContent = s.phase === 'ACTION' ? 'End Turn' : 'End Phase';
  }

  controller.subscribe(() => refresh());
  refresh();
}
