"use strict";

let _ = require("lodash");
let turf = require("@turf/turf");

let fs = require("fs");
let process = require("process");

const maxLengthForTurnAngle = 36;

let waysById;

function getLaneCount(way, progression) {
    let direction = progression > 0 ? "forward" : "backward";
    let laneCount = parseInt(way.tags["lanes:" + direction]);
    if (!laneCount) {
        laneCount = parseInt(way.tags.lanes);
        if (way.tags.oneway !== "yes" && way.tags.oneway !== "-1") {
            laneCount = Math.floor(laneCount / 2);
        }
    }
    return laneCount || 1;
}

function getTagsForProgression(tag, way, progression, laneCount) {
    let direction = progression > 0 ? "forward" : "backward";
    let tags = way.tags[`${tag}:lanes:${direction}`] || way.tags[`${tag}:lanes`];
    if (tags) {
        return tags;
    }
    
    tags = way.tags[`${tag}:${direction}`] || way.tags[tag];
    if (tags && laneCount) {
        return new Array(laneCount).fill(tags).join("|");
    }
    return tags;
}

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

function getTurnLanes(way, progression) {
    let laneCount = getLaneCount(way, progression);
    let turnTags = getTagsForProgression("turn", way, progression, laneCount);
    if (!turnTags) {
        return [];
    }
    turnTags = turnTags.split("|").map(tag => tag.split(";"));
    
    let changeTags = getTagsForProgression("change", way, progression, laneCount);
    if (changeTags) {
        changeTags = changeTags.split("|").map((tag, idx) => {
            switch (tag) {
                case "yes":
                    return [true, true];
                case "no":
                    return [false, false];
                case "not_left":
                case "only_right":
                    return [false, true];
                case "not_right":
                case "only_left":
                    return [true, false];
                default:
                    console.assert(false, "Way %s, #%s lane has unrecognized change tag %s", way.id, idx + 1, tag);
            }
        });
        
        // In reality, it may be significant whether a driver can cross the
        // double yellow line to turn across opposing traffic. However, for
        // the purposes of this analysis, focus on restrictions on changing
        // lanes between lanes going the same direction.
        _.first(changeTags)[0] = undefined;
        _.last(changeTags)[1] = undefined;
        
        if (turnTags.length !== changeTags.length) {
            console.warn("Way %s has %s turn lanes but %s lanes in change:lanes", way.id, turnTags.length, changeTags.length);
            return [];
        }
    }
    
    let lanes = _.zip(turnTags, changeTags).map(pair => _.zipObject(["turn", "change"], pair));
    
    let turns = {
        none: lanes.filter(lane => !lane.turn.length || lane.turn[0] === "none"),
        reverse: lanes.filter(lane => lane.turn.includes("reverse")),
        left: lanes.filter(lane => lane.turn.includes("left") || lane.turn.includes("slight_left")),
        through: lanes.filter(lane => lane.turn.includes("through")),
        right: lanes.filter(lane => lane.turn.includes("right") || lane.turn.includes("slight_right"))
    };
    
    let turnIsProtected = function (turn) {
        return turns[turn].length &&
            _.findIndex(turns[turn], lane => lane.change && !lane.change[0]) !== -1 &&
            _.findIndex(turns[turn], lane => lane.change && !lane.change[1]) !== -1;
    };
    
    let protections = _.mapValues({
        none: turns.none.length && _.findIndex(turns.none, lane => lane.change && !lane.change[0] && !lane.change[1]) !== -1,
        reverse: turnIsProtected("reverse"),
        left: turnIsProtected("left"),
        through: turns.through.length && _.findIndex(turns.through, lane => lane.change && !lane.change[0] && !lane.change[1]) !== -1,
        right: turnIsProtected("right")
    }, (protection, turn) => {
        if (!turns[turn].length) {
            return undefined;
        }
        let leftmostLane = turns[turn][0];
        let rightmostLane = _.last(turns[turn]);
        if (leftmostLane.change === undefined && rightmostLane.change === undefined) {
            return undefined;
        }
        if (leftmostLane.change && leftmostLane.change[0] === undefined && rightmostLane.change && rightmostLane.change[1] === undefined) {
            return undefined;
        }
        return protection;
    });
    
    let maneuverCoords = turf.getCoords(way.line).concat();
    if (progression < 0) {
        maneuverCoords.reverse();
    }
    let maneuverLine = turf.lineString(maneuverCoords);
    
    let maxSpeed = getTagsForProgression("maxspeed:advisory", way, progression) || getTagsForProgression("maxspeed", way, progression);
    
    return ["reverse", "left", "right"].filter(turn => turns[turn].length).map(turn => ({
        fromWay: way.id,
        progression: progression,
        fromNode: (progression > 0 ? _.first : _.last)(way.nodes),
        viaNode: (progression > 0 ? _.last : _.first)(way.nodes),
        line: maneuverLine,
        turn: turn,
        lanes: turns[turn].length,
        protected: protections[turn],
        maxSpeed: normalizeSpeed(maxSpeed)
    }));
}

function flattenManeuver(maneuver) {
    let next = maneuver.next;
    if (!next) {
        return;
    }
    
    flattenManeuver(next);
    
    console.assert(next.isConnection, "Next maneuver %o lacks isConnection property.", next.fromWay);
    if (maneuver.protected && next.protected === false) {
        console.warn("Maneuver disallows lane changes at way %s but allows lane changes at way %s", _.last(maneuver.fromWays), next.fromWays[0]);
    }
    
    maneuver.fromWays = maneuver.fromWays.concat(next.fromWays);
    maneuver.progressions = maneuver.progressions.concat(next.progressions);
    maneuver.line = turf.lineString(turf.getCoords(maneuver.line).concat(turf.getCoords(next.line)));
    maneuver.viaNode = next.viaNode;
    maneuver.lanes = Math.max(maneuver.lanes, next.lanes);
    
    let length = turf.length(maneuver.line, {
        units: "meters"
    });
    let nextLength = turf.length(next.line, {
        units: "meters"
    });
    
    if (!maneuver.protected && next.protected) {
        maneuver.protectionNode = next.fromNode;
    } else {
        maneuver.protectionNode = next.protectionNode;
    }
    
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
    waysById = _.fromPairs(ways.map(way => [way.id, way]));
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
            let turns = getTurnLanes(way, 1);
            wayManeuvers = wayManeuvers.concat(turns);
        }
        if (!way.tags.oneway || way.tags.oneway === "-1") {
            let turns = getTurnLanes(way, -1);
            wayManeuvers = wayManeuvers.concat(turns);
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
            
            return maneuver.protected && connectedManeuver.protected === false;
        });
        
        let bearingDeltas = connectedManeuvers.map(connectedManeuver => {
            let connectedWay = waysById[connectedManeuver.fromWay];
            
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
            
            let bearingDelta = connectedBearing - bearing;
            if (bearingDelta > 180) {
                bearingDelta -= 180;
            } else if (bearingDelta < -180) {
                bearingDelta += 180;
            }
            //if (Math.abs(bearingDelta) > 30) {
            //    console.warn("Removing", maneuver.fromWay, bearing, connectedManeuver.fromWay, connectedBearing, bearingDelta);
            //}
            return bearingDelta;
        });
        _.remove(connectedManeuvers, (connectedManeuver, idx) => Math.abs(bearingDeltas[idx]) > 30);
        
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
        
        console.assert(connectedManeuvers.length < 2, "Ambiguous maneuver from %o via one of %o with bearing deltas %s", maneuver, connectedManeuvers, bearingDeltas);
        
        if (connectedManeuvers.length) {
            maneuver.next = connectedManeuvers[0];
            connectedManeuvers[0].isConnection = true;
        }
    });
    
    maneuvers = maneuvers.map(maneuver => {
        maneuver.fromWays = [maneuver.fromWay];
        maneuver.progressions = [maneuver.progression];
        delete maneuver.fromWay;
        delete maneuver.progression;
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
        let protectedLength;
        if (maneuver.protectionNode) {
            let protectionNode = nodesById[maneuver.protectionNode];
            let viaNode = nodesById[maneuver.viaNode];
            let protectedLine = turf.lineSlice(turf.point([protectionNode.lon, protectionNode.lat]),
                                               turf.point([viaNode.lon, viaNode.lat]),
                                               maneuver.line);
            protectedLength = turf.length(protectedLine, {
                units: "meters"
            });
        }
        let entry = `${maneuver.fromNode}\t${maneuver.viaNode}\t${maneuver.turn}\t${lastWay.tags.highway}\t${maneuver.lanes}\t${length}\t${protectedLength || ""}\t${maneuver.maxSpeed || ""}`;
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
