// Imported here rather than linked from index.html so Vite bundles and
// fingerprints them; tokens first, since ui.css reads its custom properties.
import './client/styles/tokens.css';
import './client/styles/ui.css';

import StartGame from './game/main';

document.addEventListener('DOMContentLoaded', () => {

    StartGame('game-container');

});
