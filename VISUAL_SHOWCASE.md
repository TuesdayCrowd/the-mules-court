# The Mule's Court - Visual Showcase

## 🎨 Generated Graphics Preview

### Space Background

**File:** `public/assets/misc/playfield_background_space.png`

- Epic deep space nebula
- Purple and red cosmic clouds
- Distant stars and galaxies
- Foundation galactic empire atmosphere
- Perfect for immersive playfield backdrop

### Devotion Token Badge

**File:** `public/assets/misc/devotion_token.png`

- All-seeing eye symbol (The Mule's power)
- Red and purple mystical gradient
- Ornate circular medallion design
- Glowing ethereal effect
- Used for devotion token visualization

### UI Panel Texture

**File:** `public/assets/misc/ui_panel_metal.png`

- Metallic sci-fi surface
- Purple energy highlights
- Futuristic Galactic Empire design
- Reserved for future UI enhancements

## 🎮 Playfield Layouts

### 2-Player Configuration

```
╔═══════════════════════════════╗
║       PLAYER 2 AREA           ║  ← Top position
║   [Name] [Tokens] [Hand]      ║
╠═══════════════════════════════╣
║                               ║
║    ┌─────────────────┐        ║
║    │  THE MULE'S     │        ║  ← Center info
║    │    COURT        │        ║
║    │  Current: P1    │        ║
║    │  Phase: Draw    │        ║
║    └─────────────────┘        ║
║                               ║
║    ┌──────┐                   ║
║    │ DECK │ 16 cards          ║  ← Deck display
║    └──────┘                   ║
║                               ║
╠═══════════════════════════════╣
║       PLAYER 1 (YOU)          ║  ← Bottom position
║   [Name] [Tokens] [Hand]      ║
╚═══════════════════════════════╝
```

### 3-Player Configuration

```
╔═══════════════════════════════╗
║  PLAYER 2        PLAYER 3     ║  ← Top corners
║  [Info]          [Info]       ║
║                               ║
║    ┌─────────────────┐        ║
║    │  Game Info      │        ║  ← Center
║    │  & Deck         │        ║
║    └─────────────────┘        ║
║                               ║
║       PLAYER 1 (YOU)          ║  ← Bottom center
║         [Info]                ║
╚═══════════════════════════════╝
```

### 4-Player Configuration

```
╔═══════════════════════════════╗
║         PLAYER 3              ║  ← Top
║                               ║
║ PLAYER 2   [CENTER]  PLAYER 4 ║  ← Sides
║                               ║
║         PLAYER 1 (YOU)        ║  ← Bottom
╚═══════════════════════════════╝
```

## 🎭 Visual States

### Current Player (Active)

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ PLAYER 1 (YOU)           ┃  ← Red border (3px)
┃ ⚡ Current Turn           ┃  ← Lightning indicator
┃                          ┃
┃ Hand: [2 cards]          ┃  ← Purple glow
┃                          ┃
┃ Tokens: 👁️ 👁️           ┃  ← Animated fade-in
┗━━━━━━━━━━━━━━━━━━━━━━━━━━┛
   ↑ Pulsing 1.0→1.03 scale
```

### Protected Player

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ PLAYER 2                 ┃  ← Gray border (2px)
┃                          ┃
┃ ┌────────────────────┐   ┃
┃ │ 🛡️ Protected       │   ┃  ← Cyan panel
┃ │ Immune to targets  │   ┃  ← Pulsing glow
┃ └────────────────────┘   ┃     (0.3→0.7 alpha)
┃                          ┃
┃ Hand: [1 card]           ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

### Eliminated Player

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ PLAYER 3                 ┃  ← Gray border
┃                          ┃     50% opacity
┃ ┌────────────────────┐   ┃
┃ │ 💀 Eliminated      │   ┃  ← Gray panel
┃ └────────────────────┘   ┃
┃                          ┃
┃ Hand: Empty              ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━┛
   ↑ Grayscale effect
```

## 📊 Phase Indicators

### Setup Phase

```
┌─────────────────────────┐
│ THE MULE'S COURT        │
│ Setup Phase             │ ← Gray color
│ Player 1's Turn         │
└─────────────────────────┘
```

### Draw Phase

```
┌─────────────────────────┐
│ THE MULE'S COURT        │
│ → Draw Card             │ ← Blue color
│ Player 1's Turn         │
└─────────────────────────┘
```

### Play Phase

```
┌─────────────────────────┐
│ THE MULE'S COURT        │
│ → Play Card             │ ← Purple color
│ Player 1's Turn         │
└─────────────────────────┘
```

### Round Complete

```
┌─────────────────────────┐
│ THE MULE'S COURT        │
│ ✦ Round Complete        │ ← Green color
│ Player 1's Turn         │ ← Pulsing
└─────────────────────────┘
```

### Game Over

```
┌─────────────────────────┐
│ THE MULE'S COURT        │
│ ★ GAME OVER ★           │ ← Gold color
│ 👑 Player 1 WINS! 👑    │ ← Strong pulse
└─────────────────────────┘
```

## 🎯 Deck States

### Full Deck (>3 cards)

```
┌──────────────┐
│   THE DECK   │ ← Purple border
│ ┌──────────┐ │
│ │ [CARD]   │ │ ← Full opacity
│ └──────────┘ │
│   12 cards   │ ← White text
└──────────────┘
```

### Low Deck (≤3 cards)

```
┌──────────────┐
│   THE DECK   │ ← Orange border
│ ┌──────────┐ │ ← Subtle pulse
│ │ [CARD]   │ │ ← 70% opacity
│ └──────────┘ │
│   2 cards    │ ← Yellow text
└──────────────┘
```

### Empty Deck

```
┌──────────────┐
│   THE DECK   │ ← Dark red border
│ ┌──────────┐ │ ← Strong pulse
│ │ [CARD]   │ │ ← 30% opacity
│ └──────────┘ │
│    EMPTY     │ ← Red text
└──────────────┘
```

## 🎬 Animation Showcase

### Devotion Token Sequence

```
Time: 0ms
  [Empty Container]

Time: 0-500ms
  [👁️] ← Fading in (alpha 0→1)

Time: 100-600ms
  [👁️] [👁️] ← Second token fading

Time: 200-700ms
  [👁️] [👁️] [👁️] ← Third token fading

Final: All visible
  [👁️] [👁️] [👁️]
```

### Player Turn Pulse

```
t=0s:    Scale 1.00  ━━━━━━━━━━━━━━━━━━
t=0.4s:  Scale 1.03  ━━━━━━━━━━━━━━━━━━━━
t=0.8s:  Scale 1.00  ━━━━━━━━━━━━━━━━━━
t=1.2s:  Scale 1.03  ━━━━━━━━━━━━━━━━━━━━
t=1.5s:  Scale 1.00  ━━━━━━━━━━━━━━━━━━
        (Continuous loop)
```

### Protection Pulse

```
t=0.0s:  Alpha 0.3  ░░░░░░░░░░
t=0.2s:  Alpha 0.7  ████████████
t=0.4s:  Alpha 0.3  ░░░░░░░░░░
t=0.6s:  Alpha 0.7  ████████████
t=0.8s:  Alpha 0.3  ░░░░░░░░░░
        (Fast continuous loop)
```

## 🎨 Color Palette

### Primary Colors

```
Background:   #000000 (Black space)
Nebula Red:   #ef4444 (Highlights)
Nebula Purple:#a855f7 (Accents)
```

### UI Colors

```
Active Border:  #ef4444 (Red - Current player)
Inactive:       #6b7280 (Gray - Other players)
Protected:      #22d3ee (Cyan - Shield status)
Eliminated:     #9ca3af (Light gray - Out)
```

### Phase Colors

```
Setup:      #9ca3af (Gray)
Draw:       #60a5fa (Blue)
Play:       #c084fc (Purple)
Round End:  #4ade80 (Green)
Game Over:  #fbbf24 (Gold)
```

### Deck States

```
Full:    #9333ea (Purple)
Warning: #b45309 (Orange)
Empty:   #991b1b (Dark red)
```

## 🎯 Interactive Elements

### Button States

```
Normal:
  ┌──────────────┐
  │ Draw Card    │ ← bg-red-600
  └──────────────┘

Hover:
  ┌──────────────┐
  │ Draw Card    │ ← bg-red-700, scale 1.05
  └──────────────┘

Active (Pressed):
  ┌──────────────┐
  │ Draw Card    │ ← bg-red-800, scale 0.95
  └──────────────┘

Disabled:
  ┌──────────────┐
  │ Draw Card    │ ← bg-gray-600, no hover
  └──────────────┘
```

### Card Selection

```
Available:
  ┌─────────────────┐
  │ 👤 Informant    │ ← Purple background
  │ Value: 1        │ ← Hover: scale 1.05
  └─────────────────┘

Selected:
  ┌─────────────────┐
  │ 👤 Informant    │ ← Brighter purple
  │ Value: 1        │ ← Border highlight
  └─────────────────┘
```

## 📐 Layout Measurements

### Player Area

```
Width:  300px
Height: 180px
Padding: Internal (10px border radius)

Components:
  - Name text:    18px bold, -60px top
  - Status panel: 280px × 40px, -10px top
  - Tokens:       40px × 40px each, stacked horizontal
  - Hand:         150px × 60px, +50px top
```

### Center Info Panel

```
Width:  400px
Height: 120px
Position: Top center (-200px from center)

Contents:
  - Title:    24px, -35px from center
  - Phase:    16px, +5px from center
  - Player:   18px, +35px from center
```

### Deck Container

```
Width:  150px
Height: 220px
Position: Left center (0px, 0px)

Contents:
  - Card image: 120px × 180px
  - Count text: 20px, +80px
  - Label:      12px, +100px
```

## 🌟 Special Effects

### Victory Animation

```
Phase 1: Text appears
  "👑 PLAYER WINS! 👑"
  ↓ Fade in 300ms

Phase 2: Gold pulsing begins
  Scale: 0.9 → 1.15 → 0.9
  Duration: 800ms loop
  Color: #fbbf24 (Gold)

Phase 3: Continuous celebration
  Pulse continues until restart
```

### Elimination Sequence

```
Phase 1: Status appears
  💀 Eliminated banner
  ↓ Fade in 200ms

Phase 2: Container dims
  Opacity: 1.0 → 0.5
  Duration: 500ms

Phase 3: Grayscale effect
  Applied immediately
  Remains until round end
```

---

**All visuals created with Phaser GPU rendering**
**Smooth 60fps maintained across all animations**
**Foundation universe aesthetic throughout**
