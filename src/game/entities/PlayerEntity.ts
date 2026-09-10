import Phaser from "phaser";

function brightenColor(hex: number, amount: number): number {
  const r = (hex >> 16) & 0xff;
  const g = (hex >> 8) & 0xff;
  const b = hex & 0xff;
  const nr = Math.min(255, Math.round(r + (255 - r) * amount));
  const ng = Math.min(255, Math.round(g + (255 - g) * amount));
  const nb = Math.min(255, Math.round(b + (255 - b) * amount));
  return (nr << 16) | (ng << 8) | nb;
}

export class PlayerEntity {
  private readonly body: Phaser.GameObjects.Rectangle;
  private readonly nameLabel: Phaser.GameObjects.Text;
  private readonly baseFill: number;
  private readonly baseStroke: number;

  constructor(scene: Phaser.Scene, x: number, y: number, name: string, fillColor = 0x38bdf8, strokeColor = 0x0ea5e9) {
    this.baseFill = fillColor;
    this.baseStroke = strokeColor;
    this.body = scene.add.rectangle(x, y, 42, 42, fillColor);
    this.body.setStrokeStyle(2, strokeColor);

    this.nameLabel = scene.add
      .text(x, y - 36, name, {
        fontFamily: "Arial",
        fontSize: "16px",
        color: "#e2e8f0",
        stroke: "#0f172a",
        strokeThickness: 4
      })
      .setOrigin(0.5, 0.5);
  }

  setPosition(x: number, y: number): void {
    this.body.setPosition(x, y);
    this.nameLabel.setPosition(x, y - 36);
  }

  /** Highlight when this player is detected as speaking (voice activity). */
  setSpeakingHighlight(active: boolean): void {
    const fill = active ? brightenColor(this.baseFill, 0.42) : this.baseFill;
    const stroke = active ? brightenColor(this.baseStroke, 0.35) : this.baseStroke;
    this.body.setFillStyle(fill);
    this.body.setStrokeStyle(2, stroke);
  }

  getPosition(): { x: number; y: number } {
    return { x: this.body.x, y: this.body.y };
  }

  getBody(): Phaser.GameObjects.Rectangle {
    return this.body;
  }

  destroy(): void {
    this.body.destroy();
    this.nameLabel.destroy();
  }
}
