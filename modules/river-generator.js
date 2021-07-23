(function (global, factory) {
  typeof exports === "object" && typeof module !== "undefined" ? (module.exports = factory()) : typeof define === "function" && define.amd ? define(factory) : (global.Rivers = factory());
})(this, function () {
  "use strict";

  const generate = function (allowErosion = true) {
    TIME && console.time("generateRivers");
    Math.random = aleaPRNG(seed);
    const {cells, features} = pack;
    const p = cells.p;

    const riversData = []; // rivers data
    cells.fl = new Uint16Array(cells.i.length); // water flux array
    cells.r = new Uint16Array(cells.i.length); // rivers array
    cells.conf = new Uint8Array(cells.i.length); // confluences array
    let riverNext = 1; // first river id is 1

    const h = alterHeights();
    Lakes.prepareLakeData(h);
    resolveDepressions(h);
    drainWater();
    lineGen.curve(d3.curveCatmullRom.alpha(0.1));
    defineRivers();
    calculateConfluenceFlux();
    Lakes.cleanupLakeData();

    if (allowErosion) cells.h = Uint8Array.from(h); // apply changed heights as basic one

    TIME && console.timeEnd("generateRivers");

    function drainWater() {
      const MIN_FLUX_TO_FORM_RIVER = 30;
      const prec = grid.cells.prec;
      const land = cells.i.filter(i => h[i] >= 20).sort((a, b) => h[b] - h[a]);
      const lakeOutCells = Lakes.setClimateData(h);

      land.forEach(function (i) {
        cells.fl[i] += prec[cells.g[i]]; // add flux from precipitation

        // create lake outlet if lake is not in deep depression and flux > evaporation
        const lakes = lakeOutCells[i] ? features.filter(feature => i === feature.outCell && feature.flux > feature.evaporation) : [];
        for (const lake of lakes) {
          const lakeCell = cells.c[i].find(c => h[c] < 20 && cells.f[c] === lake.i);
          cells.fl[lakeCell] += Math.max(lake.flux - lake.evaporation, 0); // not evaporated lake water drains to outlet

          // allow chain lakes to retain identity
          if (cells.r[lakeCell] !== lake.river) {
            const sameRiver = cells.c[lakeCell].some(c => cells.r[c] === lake.river);

            if (sameRiver) {
              cells.r[lakeCell] = lake.river;
              riversData.push({river: lake.river, cell: lakeCell});
            } else {
              cells.r[lakeCell] = riverNext;
              riversData.push({river: riverNext, cell: lakeCell});
              riverNext++;
            }
          }

          lake.outlet = cells.r[lakeCell];
          flowDown(i, cells.fl[lakeCell], lake.outlet);
        }

        // assign all tributary rivers to outlet basin
        for (let outlet = lakes[0]?.outlet, l = 0; l < lakes.length; l++) {
          lakes[l].inlets?.forEach(fork => (riversData.find(r => r.river === fork).parent = outlet));
        }

        // near-border cell: pour water out of the screen
        if (cells.b[i] && cells.r[i]) {
          riversData.push({river: cells.r[i], cell: -1});
          return;
        }

        // downhill cell (make sure it's not in the source lake)
        let min = null;
        if (lakeOutCells[i]) {
          const filtered = cells.c[i].filter(c => !lakes.map(lake => lake.i).includes(cells.f[c]));
          min = filtered.sort((a, b) => h[a] - h[b])[0];
        } else if (cells.haven[i]) {
          min = cells.haven[i];
        } else {
          min = cells.c[i].sort((a, b) => h[a] - h[b])[0];
        }

        // cells is depressed
        if (h[i] <= h[min]) return;

        if (cells.fl[i] < MIN_FLUX_TO_FORM_RIVER) {
          // flux is too small to operate as a river
          if (h[min] >= 20) cells.fl[min] += cells.fl[i];
          return;
        }

        // proclaim a new river
        if (!cells.r[i]) {
          cells.r[i] = riverNext;
          riversData.push({river: riverNext, cell: i});
          riverNext++;
        }

        flowDown(min, cells.fl[i], cells.r[i]);
      });
    }

    function flowDown(toCell, fromFlux, river) {
      const toFlux = cells.fl[toCell] - cells.conf[toCell];

      if (cells.r[toCell]) {
        // downhill cell already has river assigned
        if (fromFlux > toFlux) {
          cells.conf[toCell] += cells.fl[toCell]; // mark confluence
          if (h[toCell] >= 20) {
            // min river is a tributary of current river
            const toRiver = riversData.find(r => r.river === cells.r[toCell]);
            if (toRiver) toRiver.parent = river;
          }
          cells.r[toCell] = river; // re-assign river if downhill part has less flux
        } else {
          cells.conf[toCell] += fromFlux; // mark confluence
          if (h[toCell] >= 20) {
            // current river is a tributary of min river
            const thisRiver = riversData.find(r => r.river === river);
            if (thisRiver) thisRiver.parent = cells.r[toCell];
          }
        }
      } else cells.r[toCell] = river; // assign the river to the downhill cell

      if (h[toCell] < 20) {
        // pour water to the water body
        const waterBody = features[cells.f[toCell]];
        if (waterBody.type === "lake") {
          if (!waterBody.river || fromFlux > waterBody.enteringFlux) {
            waterBody.river = river;
            waterBody.enteringFlux = fromFlux;
          }
          waterBody.flux = waterBody.flux + fromFlux;
          if (!waterBody.inlets) waterBody.inlets = [river];
          else waterBody.inlets.push(river);
        }
      } else {
        // propagate flux and add next river segment
        cells.fl[toCell] += fromFlux;
      }

      riversData.push({river, cell: toCell});
    }

    function defineRivers() {
      // re-initialize rivers and confluence arrays
      cells.r = new Uint16Array(cells.i.length);
      cells.conf = new Uint16Array(cells.i.length);
      pack.rivers = [];
      const riverPaths = [];

      for (let r = 1; r <= riverNext; r++) {
        const riverData = riversData.filter(d => d.river === r);
        if (riverData.length < 3) continue; // exclude tiny rivers

        for (const segment of riverData) {
          const i = segment.cell;
          if (i < 0 || cells.h[i] < 20) continue;

          // mark real confluences and assign river to cells
          if (cells.r[i]) cells.conf[i] = 1;
          else cells.r[i] = r;
        }

        const source = riverData[0].cell;
        const mouth = riverData[riverData.length - 2].cell;
        const parent = riverData[0].parent || 0;

        const riverCells = riverData.map(point => point.cell);
        const widthFactor = !parent || parent === r ? 1.2 : 1;
        const initStep = cells.h[source] >= 20 ? 1 : 10;
        const riverMeandered = addMeandering(riverCells, initStep, 0.5);
        const [path, length, offset] = getRiverPath(riverMeandered, widthFactor);
        riverPaths.push([path, r]);

        // Real mounth width examples: Amazon 6000m, Volga 6000m, Dniepr 3000m, Mississippi 1300m, Themes 900m,
        // Danube 800m, Daugava 600m, Neva 500m, Nile 450m, Don 400m, Wisla 300m, Pripyat 150m, Bug 140m, Muchavets 40m
        const width = rn((offset / 1.4) ** 2, 2); // mounth width in km
        const discharge = last(riverData).flux; // in m3/s

        pack.rivers.push({i: r, source, mouth, discharge, length, width, widthFactor, sourceWidth: 0, parent, cells: riverCells});
      }

      // draw rivers
      rivers.html(riverPaths.map(d => `<path id="river${d[1]}" d="${d[0]}"/>`).join(""));
    }

    function calculateConfluenceFlux() {
      for (const i of cells.i) {
        if (!cells.conf[i]) continue;

        const sortedInflux = cells.c[i]
          .filter(c => cells.r[c] && h[c] > h[i])
          .map(c => cells.fl[c])
          .sort((a, b) => b - a);
        cells.conf[i] = sortedInflux.reduce((acc, flux, index) => (index ? acc + flux : acc), 0);
      }
    }
  };

  // add distance to water value to land cells to make map less depressed
  const alterHeights = () => {
    const {h, c, t} = pack.cells;
    return Array.from(h).map((h, i) => {
      if (h < 20 || t[i] < 1) return h;
      return h + t[i] / 100 + d3.mean(c[i].map(c => t[c])) / 10000;
    });
  };

  // depression filling algorithm (for a correct water flux modeling)
  const resolveDepressions = function (h) {
    const {cells, features} = pack;
    const maxIterations = +document.getElementById("resolveDepressionsStepsOutput").value;
    const checkLakeMaxIteration = maxIterations * 0.85;
    const elevateLakeMaxIteration = maxIterations * 0.75;

    const height = i => features[cells.f[i]].height || h[i]; // height of lake or specific cell

    const lakes = features.filter(f => f.type === "lake");
    const land = cells.i.filter(i => h[i] >= 20 && !cells.b[i]); // exclude near-border cells
    land.sort((a, b) => h[a] - h[b]); // lowest cells go first

    const progress = [];
    let depressions = Infinity;
    let prevDepressions = null;
    for (let iteration = 0; depressions && iteration < maxIterations; iteration++) {
      if (progress.length > 5 && d3.sum(progress) > 0) {
        // bad progress, abort and set heights back
        h = alterHeights();
        depressions = progress[0];
        break;
      }

      depressions = 0;

      if (iteration < checkLakeMaxIteration) {
        for (const l of lakes) {
          if (l.closed) continue;
          const minHeight = d3.min(l.shoreline.map(s => h[s]));
          if (minHeight >= 100 || l.height > minHeight) continue;

          if (iteration > elevateLakeMaxIteration) {
            l.shoreline.forEach(i => (h[i] = cells.h[i]));
            l.height = d3.min(l.shoreline.map(s => h[s])) - 1;
            l.closed = true;
            continue;
          }

          depressions++;
          l.height = minHeight + 0.2;
        }
      }

      for (const i of land) {
        const minHeight = d3.min(cells.c[i].map(c => height(c)));
        if (minHeight >= 100 || h[i] > minHeight) continue;

        depressions++;
        h[i] = minHeight + 0.1;
      }

      prevDepressions !== null && progress.push(depressions - prevDepressions);
      prevDepressions = depressions;
    }

    depressions && WARN && console.warn(`Unresolved depressions: ${depressions}. Edit heightmap to fix`);
  };

  // add points at 1/3 and 2/3 of a line between adjacents river cells
  const addMeandering = function (riverCells, step = 1, meandering = 0.5) {
    const meandered = [];
    const {p, fl, conf} = pack.cells;

    const lastStep = riverCells.length - 1;
    let fluxPrev = 0;
    const getFlux = (step, flux) => (step === lastStep ? fluxPrev : flux);

    for (let i = 0; i <= lastStep; i++, step++) {
      const cell = riverCells[i];
      const isLastCell = i === lastStep;

      const [x1, y1] = p[cell];
      const flux1 = getFlux(i, fl[cell]);
      fluxPrev = flux1;

      meandered.push([x1, y1, flux1]);

      if (isLastCell) break;

      const nextCell = riverCells[i + 1];
      if (nextCell === -1) {
        const [x, y] = getBorderPoint(cell);
        meandered.push([x, y, fluxPrev]);
        break;
      }

      const [x2, y2] = p[nextCell];
      const dist2 = (x2 - x1) ** 2 + (y2 - y1) ** 2; // square distance between cells
      if (dist2 <= 25 && riverCells.length >= 6) continue;

      const flux2 = getFlux(i + 1, fl[nextCell]);
      const keepInitialFlux = conf[nextCell] || flux1 === flux2;

      const meander = meandering + 1 / step + Math.random() * Math.max(meandering - step / 100, 0);
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const sinMeander = Math.sin(angle) * meander;
      const cosMeander = Math.cos(angle) * meander;

      if (step < 10 && (dist2 > 64 || (dist2 > 36 && riverCells.length < 5))) {
        // if dist2 is big or river is small add extra points at 1/3 and 2/3 of segment
        const p1x = (x1 * 2 + x2) / 3 + -sinMeander;
        const p1y = (y1 * 2 + y2) / 3 + cosMeander;
        const p2x = (x1 + x2 * 2) / 3 + sinMeander;
        const p2y = (y1 + y2 * 2) / 3 + cosMeander;
        const [p1fl, p2fl] = keepInitialFlux ? [flux1, flux1] : [(flux1 * 2 + flux2) / 3, (flux1 + flux2 * 2) / 3];
        meandered.push([p1x, p1y, p1fl], [p2x, p2y, p2fl]);
      } else if (dist2 > 25 || riverCells.length < 6) {
        // if dist is medium or river is small add 1 extra middlepoint
        const p1x = (x1 + x2) / 2 + -sinMeander;
        const p1y = (y1 + y2) / 2 + cosMeander;
        const p1fl = keepInitialFlux ? flux1 : (flux1 + flux2) / 2;
        meandered.push([p1x, p1y, p1fl]);
      }
    }

    return meandered;
  };

  const fluxFactor = 500;
  const maxFluxWidth = 2;
  const widthFactor = 200;
  const stepWidth = 1 / widthFactor;
  const lengthProgression = [1, 1, 2, 3, 5, 8, 13, 21, 34].map(n => n / widthFactor);
  const maxProgression = last(lengthProgression);

  // build polygon from a list of points and calculated offset (width)
  const getRiverPath = function (points, widthFactor = 1, startingWidth = 0) {
    const riverLength = points.reduce((s, v, i, p) => s + (i ? Math.hypot(v[0] - p[i - 1][0], v[1] - p[i - 1][1]) : 0), 0);
    let width = 0;

    const riverPointsLeft = [];
    const riverPointsRight = [];

    for (let p = 0; p < points.length; p++) {
      const [x0, y0] = points[p - 1] || points[p];
      const [x1, y1, flux] = points[p];
      const [x2, y2] = points[p + 1] || points[p];

      const fluxWidth = Math.min(flux ** 0.9 / fluxFactor, maxFluxWidth);
      const lengthWidth = p * stepWidth + (lengthProgression[p] || maxProgression);
      width = widthFactor * (lengthWidth + fluxWidth) + startingWidth;

      const angle = Math.atan2(y0 - y2, x0 - x2);
      const sinOffset = Math.sin(angle) * width;
      const cosOffset = Math.cos(angle) * width;

      riverPointsLeft.push([x1 - sinOffset, y1 + cosOffset]);
      riverPointsRight.push([x1 + sinOffset, y1 - cosOffset]);
    }

    const right = lineGen(riverPointsRight.reverse());
    let left = lineGen(riverPointsLeft);
    left = left.substring(left.indexOf("C"));

    return [round(right + left, 2), rn(riverLength, 2), width];
  };

  const specify = function () {
    const rivers = pack.rivers;
    if (!rivers.length) return;
    Math.random = aleaPRNG(seed);
    const thresholdElement = Math.ceil(rivers.length * 0.15);
    const smallLength = rivers.map(r => r.length || 0).sort((a, b) => a - b)[thresholdElement];
    const smallType = {Creek: 9, River: 3, Brook: 3, Stream: 1}; // weighted small river types

    for (const r of rivers) {
      r.basin = getBasin(r.i);
      r.name = getName(r.mouth);
      const small = r.length < smallLength;
      r.type = r.parent && !(r.i % 6) ? (small ? "Branch" : "Fork") : small ? rw(smallType) : "River";
    }
  };

  const getName = function (cell) {
    return Names.getCulture(pack.cells.culture[cell]);
  };

  // remove river and all its tributaries
  const remove = function (id) {
    const cells = pack.cells;
    const riversToRemove = pack.rivers.filter(r => r.i === id || r.parent === id || r.basin === id).map(r => r.i);
    riversToRemove.forEach(r => rivers.select("#river" + r).remove());
    cells.r.forEach((r, i) => {
      if (!r || !riversToRemove.includes(r)) return;
      cells.r[i] = 0;
      cells.fl[i] = grid.cells.prec[cells.g[i]];
      cells.conf[i] = 0;
    });
    pack.rivers = pack.rivers.filter(r => !riversToRemove.includes(r.i));
  };

  const getBasin = function (r) {
    const parent = pack.rivers.find(river => river.i === r)?.parent;
    if (!parent || r === parent) return r;
    return getBasin(parent);
  };

  const getBorderPoint = i => {
    const [x, y] = pack.cells.p[i];
    const min = Math.min(y, graphHeight - y, x, graphWidth - x);
    if (min === y) return [x, 0];
    else if (min === graphHeight - y) return [x, graphHeight];
    else if (min === x) return [0, y];
    return [graphWidth, y];
  };

  return {generate, alterHeights, resolveDepressions, addMeandering, getPath: getRiverPath, specify, getName, getBasin, remove};
});
