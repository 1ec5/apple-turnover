"use strict";

let _ = require("lodash");
let turf = require("@turf/turf");

let fs = require("fs");
let process = require("process");

const maxLengthForTurnAngle = 36;

function normalizeSpeed(speed) {
    if (!speed) {
        return speed;
    }
    if (typeof(speed) === "string") {
        if (speed.endsWith(" mph")) {
            return parseFloat(speed.replace(/ mph$/, "")) * 1609.344 / (60 * 60);
        } else {
            speed = parseFloat(speed);
        }
    }
    // Kilometers per hour to meters per hour
    return speed * 1000;
}

function turnTagToManeuvers(turn) {
    return {
        none: turn && turn.split("|").filter(lane => !lane || lane === "none").length,
        reverse: turn && _.size(turn.match(/(?:^|\||;)reverse/g)),
        left: turn && _.size(turn.match(/(?:^|\||;|slight_)left/g)),
        through: turn && _.size(turn.match(/(?:^|\||;)through/g)),
        right: turn && _.size(turn.match(/(?:^|\||;|slight_)right/g))
    };
}

function flattenManeuver(maneuver) {
    let next = maneuver.next;
    if (!next) {
        return;
    }
    
    flattenManeuver(next);
    
    console.assert(next.isConnection, "Next maneuver %o lacks isConnection property.", next.fromWay);
    
    maneuver.fromWays = maneuver.fromWays.concat(next.fromWays);
    maneuver.line = turf.lineString(turf.getCoords(maneuver.line).concat(turf.getCoords(next.line)));
    maneuver.viaNode = next.viaNode;
    maneuver.lanes = Math.max(maneuver.lanes, next.lanes);
    
    let length = turf.length(maneuver.line, {
        units: "meters"
    });
    let nextLength = turf.length(next.line, {
        units: "meters"
    });
    
    if (maneuver.maxSpeed && next.maxSpeed) {
        maneuver.maxSpeed = (length * maneuver.maxSpeed + nextLength * next.maxSpeed) / (length + nextLength);
    } else {
        maneuver.maxSpeed = maneuver.maxSpeed || next.maxSpeed;
    }
    
    delete maneuver.next;
}

let input = process.argv[2];
let output = process.argv[3];
if (!input) {
    console.error("Usage: node index.js input.json [output.csv]");
    return;
}

fs.readFile(input, (err, data) => {
    if (err) {
        console.error(err);
        return;
    }
    
    let results = JSON.parse(data);
    let elts = results.elements;
    let ways = elts.filter(elt => elt.type === "way");
    let waysById = _.fromPairs(ways.map(way => [way.id, way]));
    let nodes = elts.filter(elt => elt.type === "node");
    let nodesById = _.fromPairs(nodes.map(node => [node.id, node]));
    
    let wayIdsByFirstNodeId = {};
    let wayIdsByLastNodeId = {};
    let maneuvers = [];
    ways.forEach(way => {
        let nodes = way.nodes.map(id => nodesById[id]);
        let coords = nodes.map(node => [node.lon, node.lat]);
        way.line = turf.lineString(coords);
        
        let firstNodeId = way.nodes[0];
        if (!("firstNodeId" in wayIdsByFirstNodeId)) {
            wayIdsByFirstNodeId[firstNodeId] = [];
        }
        wayIdsByFirstNodeId[firstNodeId].push(way.id);
        let lastNodeId = _.last(way.nodes);
        if (!("lastNodeId" in wayIdsByLastNodeId)) {
            wayIdsByLastNodeId[lastNodeId] = [];
        }
        wayIdsByLastNodeId[lastNodeId].push(way.id);
        
        if ((way.tags.turn || (way.tags.lanes === "1")) && way.tags.highway.includes("_link")) {
            return;
        }
        
        let wayManeuvers = [];
        if (!way.tags.oneway || way.tags.oneway === "yes") {
            let turns = turnTagToManeuvers(way.tags["turn:lanes:forward"] || way.tags["turn:lanes"] || way.tags["turn:forward"] || way.tags.turn);
            ["reverse", "left", "right"].filter(turn => turns[turn]).forEach(turn => {
                wayManeuvers.push({
                    fromWay: way.id,
                    progression: 1,
                    fromNode: _.first(way.nodes),
                    viaNode: _.last(way.nodes),
                    line: way.line,
                    turn: turn,
                    lanes: turns[turn],
                    maxSpeed: normalizeSpeed(way.tags["maxspeed:lanes:forward"] || way.tags["maxspeed:lanes"] || way.tags["maxspeed:forward"] || way.tags.maxspeed)
                });
            });
        }
        if (!way.tags.oneway || way.tags.oneway === "-1") {
            let maneuverCoords = coords.concat();
            maneuverCoords.reverse();
            let maneuverLine = turf.lineString(maneuverCoords);
            
            let turns = turnTagToManeuvers(way.tags["turn:lanes:backward"] || way.tags["turn:lanes"] || way.tags["turn:backward"] || way.tags.turn);
            ["reverse", "left", "right"].filter(turn => turns[turn]).forEach(turn => {
                wayManeuvers.push({
                    fromWay: way.id,
                    progression: -1,
                    fromNode: _.last(way.nodes),
                    viaNode: _.first(way.nodes),
                    line: maneuverLine,
                    turn: turn,
                    lanes: turns[turn],
                    maxSpeed: normalizeSpeed(way.tags["maxspeed:lanes:backward"] || way.tags["maxspeed:lanes"] || way.tags["maxspeed:backward"] || way.tags.maxspeed)
                });
            });
        }
        maneuvers = maneuvers.concat(wayManeuvers);
    });
    
    maneuvers.forEach(maneuver => {
        let connectedManeuvers = maneuvers.filter(otherManeuver =>
            otherManeuver.fromNode === maneuver.viaNode &&
            otherManeuver.fromWay !== maneuver.fromWay &&
            otherManeuver.turn === maneuver.turn
        );
        
        let way = waysById[maneuver.fromWay];
        
        let wayLength = turf.length(way.line, {
            units: "meters"
        });
        let startOffset;
        let endOffset;
        if (maneuver.progression > 0) {
            startOffset = 0;
            endOffset = wayLength;
        } else {
            startOffset = wayLength;
            endOffset = 0;
        }
        let bearing = turf.bearing(turf.along(way.line, startOffset, {
            units: "meters"
        }), turf.along(way.line, endOffset, {
            units: "meters"
        }));
        
        _.remove(connectedManeuvers, connectedManeuver => {
            let connectedWay = waysById[connectedManeuver.fromWay];
            
            if ((way.tags.highway !== "service" && connectedWay.tags.highway === "service") ||
                (!way.tags.highway.includes("_link") && connectedWay.tags.highway.includes("_link"))) {
                return true;
            }
            
            let startOffset;
            let endOffset;
            let connectedWayLength = turf.length(connectedWay.line, {
                units: "meters"
            });
            if (connectedManeuver.progression > 0) {
                startOffset = 0;
                endOffset = Math.min(wayLength, connectedWayLength, maxLengthForTurnAngle);
            } else {
                startOffset = connectedWayLength;
                endOffset = connectedWayLength - Math.min(wayLength, connectedWayLength, maxLengthForTurnAngle);
            }
            let connectedBearing = turf.bearing(turf.along(connectedWay.line, startOffset, {
                units: "meters"
            }), turf.along(connectedWay.line, endOffset, {
                units: "meters"
            }));
            
            //if (Math.abs(connectedBearing - bearing) > 20) {
            //    console.log("Removing", maneuver.fromWay, bearing, connectedManeuver.fromWay, connectedBearing, Math.abs(connectedBearing - bearing));
            //}
            return Math.abs(connectedBearing - bearing) > 30;
        });
        
        if (connectedManeuvers.length > 1) {
            let sameClassManeuvers = connectedManeuvers.filter(connectedManeuver => {
                let connectedWay = waysById[connectedManeuver.fromWay];
                return connectedWay.tags.highway === way.tags.highway;
            });
            if (sameClassManeuvers.length) {
                connectedManeuvers = sameClassManeuvers;
            }
        }
        
        if (connectedManeuvers.length > 1) {
            let sameNamedManeuvers = connectedManeuvers.filter(connectedManeuver => {
                let connectedWay = waysById[connectedManeuver.fromWay];
                return connectedWay.tags.name === way.tags.name;
            });
            if (sameNamedManeuvers.length) {
                connectedManeuvers = sameNamedManeuvers;
            }
        }
        
        console.assert(connectedManeuvers.length < 2, "Ambiguous maneuver from %o via one of %o", maneuver, connectedManeuvers);
        
        if (connectedManeuvers.length) {
            maneuver.next = connectedManeuvers[0];
            connectedManeuvers[0].isConnection = true;
        }
    });
    
    maneuvers = maneuvers.map(maneuver => {
        maneuver.fromWays = [maneuver.fromWay];
        delete maneuver.fromWay;
        return maneuver;
    });
    
    maneuvers = maneuvers.filter(maneuver => !maneuver.isConnection);
    maneuvers.forEach(flattenManeuver);
    
    let writer = output && fs.createWriteStream(output);
    maneuvers.forEach(maneuver => {
        let lastWay = waysById[_.last(maneuver.fromWays)];
        let length = turf.length(maneuver.line, {
            units: "meters"
        });
        let entry = `${maneuver.fromNode}\t${maneuver.viaNode}\t${maneuver.turn}\t${lastWay.tags.highway}\t${maneuver.lanes}\t${length}\t${maneuver.maxSpeed || ""}`;
        if (writer) {
            writer.write(entry + "\n");
        } else {
            console.log(entry);
        }
    });
    if (writer) {
        writer.end();
    }
});
