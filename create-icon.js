const fs = require('fs');
const { createCanvas } = require('canvas');

// Create a simple icon for the tray
function createIcon() {
  const size = 256;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Background - rounded rectangle with gradient
  const gradient = ctx.createLinearGradient(0, 0, size, size);
  gradient.addColorStop(0, '#3B82F6'); // Blue
  gradient.addColorStop(1, '#1E40AF'); // Darker blue
  
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, size * 0.2);
  ctx.fill();

  // Add "E" letter (for E-Ticaret)
  ctx.fillStyle = 'white';
  ctx.font = `bold ${size * 0.5}px Arial`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('E', size / 2, size / 2);

  // Save as PNG
  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync('build/icon.png', buffer);
  
  console.log('Icon created successfully!');
}

createIcon();
