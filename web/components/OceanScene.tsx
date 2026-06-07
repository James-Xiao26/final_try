"use client";

import { useEffect, useState } from "react";

// The abyssal backdrop shared by every page: a fixed gradient + sonar mesh + grain, with drifting
// "plankton" particles. Particles are generated on the client (after mount) so server and first
// client render match — avoiding a hydration mismatch from the randomized positions.
interface Particle {
  left: string;
  size: number;
  duration: string;
  delay: string;
  opacity: number;
}

export default function OceanScene() {
  const [particles, setParticles] = useState<Particle[]>([]);

  useEffect(() => {
    const next = Array.from({ length: 22 }, () => {
      const duration = 14 + Math.random() * 16;
      const size = 1.5 + Math.random() * 3;
      return {
        // cap at 96vw so a particle's box never seeds past the right edge (no horizontal overflow)
        left: `${Math.random() * 96}vw`,
        size,
        duration: `${duration}s`,
        delay: `${-Math.random() * duration}s`,
        opacity: 0.3 + Math.random() * 0.4
      };
    });
    setParticles(next);
  }, []);

  return (
    <>
      <div className="scene" aria-hidden>
        <div className="scene-gradient" />
        <div className="scene-mesh" />
        <div className="scene-grain" />
      </div>
      <div className="plankton" aria-hidden>
        {particles.map((p, i) => (
          <span
            key={i}
            style={{
              left: p.left,
              width: p.size,
              height: p.size,
              opacity: p.opacity,
              animationDuration: p.duration,
              animationDelay: p.delay
            }}
          />
        ))}
      </div>
    </>
  );
}
