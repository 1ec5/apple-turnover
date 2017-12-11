"use strict";

let _ = require("lodash");
let turf = require("@turf/turf");

let fs = require("fs");
let process = require("process");

/**
 * {Number} Maximum length in meters of the segment of a connecting way that is
 * included in the turn angle calculation between two maneuvers that are
 * candidates for linking.
 */
const maxBearingDeltaRadius = 36;

///**
// * {Array<String>} Valid road classifications (highway=* tag values) ordered
// * from most important to least important.
// */
//const roadClassifications = [
//    "service",
//    "living_street",
//    "residential",
//    "unclassified",
//    "tertiary_link",
//    "tertiary",
//    "secondary_link",
//    "secondary",
//    "primary_link",
//    "primary",
//    "trunk_link",
//    "trunk",
//    "motorway_link",
//    "motorway"
//];

/**
 * {Object<Object>} A table mapping OpenStreetMap way IDs to the corresponding
 * way objects.
 */
let waysById;

/**
 * Returns the number of lanes in the given way going in a particular direction.
 *
 * @param way {Object} The way on which to count the lanes.
 * @param progression {Number} A positive number for the forward direction or a
 *  negative number for the backward direction.
 * @returns {Number} The number of lanes in one direction.
 */
function getLaneCount(way, progression) {
    let direction = progression > 0 ? "forward" : "backward";
    let laneCount = parseInt(way.tags["lanes:" + direction]);
    if (!laneCount) {
        laneCount = parseInt(way.tags.lanes);
        if (way.progressions.forward && way.progressions.backward) {
            laneCount = Math.floor(laneCount / 2);
        }
    }
    return laneCount || 1;
}

/**
 * Returns the value of a tag on the given way, respecting directional variants
 * of the tag.
 *
 * @param tag {String} The base tag name, not including `:lanes`, `:backward`,
 *  or `:forward`.
 * @param way {Object} The tagged way.
 * @param progression {Number} A positive number for the forward direction or a
 *  negative number for the backward direction.
 * @param laneCount {Number} The number of lanes in the direction indicated by
 *  `progression`.
 * @returns {String} The tag value.
 */
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

/**
 * Returns the given speed expressed in meters per second.
 *
 * @param speed {String|Number} A speed tag value in kilometers per hour or
 *  miles per hour.
 * @returns {Number} The equivalent speed in meters per second.
 */
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

/**
 * Returns the turn maneuvers allowed by the given way going in a single
 * direction.
 *
 * A maneuver object has the following properties:
 *
 * - fromWay {Number} The ID of the way representing the turn lane.
 * - progression {Number} A positive number for the forward direction or a
 *      negative number for the backward direction.
 * - fromNode {Number} The ID of the node representing the start of the turn
 *      lane.
 * - viaNode {Number} The ID of the node representing the end of the turn lane.
 * - line {LineString} The turn lane's geometry.
 * - turn {String} The allowed turn as "reverse", "left", or "right".
 * - lanes {Number} The number of lanes that can be used for the maneuver.
 * - protected {Boolean} True if the maneuver has at least one dedicated lane
 *      subject to a lane change restriction.
 * - maxSpeed {Number} The maximum speed limit in meters per second.
 *
 * @param way {Object} A way tagged with turn lanes.
 * @param progression {Number} A positive number for the forward direction or a
 *  negative number for the backward direction.
 * @returns {Array<Object>} Turn maneuvers allowed by the way.
 */
function getManeuversFromWay(way, progression) {
    // Get turn lane indications.
    let laneCount = getLaneCount(way, progression);
    let turnTags = getTagsForProgression("turn", way, progression, laneCount);
    if (!turnTags) {
        return [];
    }
    
    // Convert the turn lane indications into a structured format: an array, one
    // entry per lane, each entry containing an inner array of turn indication
    // strings.
    turnTags = turnTags.split("|").map(tag => tag.split(";"));
    
    // Get lane change restrictions.
    let changeTags = getTagsForProgression("change", way, progression, laneCount);
    if (changeTags) {
        // Convert the lane change restrictions into a structured format: an
        // array, one entry per lane, each entry an array of two Booleans
        // indicating whether a change is allowed to the left or the right of
        // that lane.
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
                    console.warn("Way %s, #%s lane has unrecognized change tag %s",
                                 way.id, idx + 1, tag);
                    return [true, true];
            }
        });
        
        // In reality, it may be significant whether a driver can cross the
        // double yellow line to turn across opposing traffic. However, for
        // the purposes of this analysis, focus on restrictions on changing
        // lanes between lanes going the same direction.
        _.first(changeTags)[0] = undefined;
        _.last(changeTags)[1] = undefined;
        
        if (turnTags.length !== changeTags.length) {
            console.warn("Way %s has %s turn lanes but %s lanes in change:lanes",
                         way.id, turnTags.length, changeTags.length);
            return [];
        }
    }
    
    // Model each lane based on its turn indication and lane change
    // restrictions.
    let lanes = _.zip(turnTags, changeTags).map(pair => _.zipObject(["turn", "change"], pair));
    
    // Classify the lanes by their turn lane indications. For the purposes of
    // this analysis, slight turns (such as on exit lanes) are equivalent to
    // full turns, and merge indications are irrelevant.
    let turns = {
        none: lanes.filter(lane => !lane.turn.length || lane.turn[0] === "none"),
        reverse: lanes.filter(lane => lane.turn.includes("reverse")),
        left: lanes.filter(lane => lane.turn.includes("left") || lane.turn.includes("slight_left")),
        through: lanes.filter(lane => lane.turn.includes("through")),
        right: lanes.filter(lane => lane.turn.includes("right") || lane.turn.includes("slight_right"))
    };
    
    /**
     * Returns whether a lane used for the given turn is subject to lane change
     * restrictions.
     *
     * @param turn {String} The allowed turn as "reverse", "left", or "right".
     * @returns {Boolean} True if a lane used for the turn is subject to lane
     *  change restrictions, other than the natural restrictions at either side
     *  of the road.
     */
    let turnIsProtected = function (turn) {
        return turns[turn].length &&
            // Does any of the lanes have a solid line to the left?
            _.findIndex(turns[turn], lane => lane.change && !lane.change[0]) !== -1 &&
            // Does any of the lanes have a solid line to the right?
            _.findIndex(turns[turn], lane => lane.change && !lane.change[1]) !== -1;
    };
    
    // Determine whether each turn is subject to lane change restrictions.
    let protections = _.mapValues({
        // Is any of the unmarked lanes flanked by solid lines?
        none: turns.none.length &&
            _.findIndex(turns.none, lane => lane.change && !lane.change[0] && !lane.change[1]) !== -1,
        reverse: turnIsProtected("reverse"),
        left: turnIsProtected("left"),
        // Is any of the through lanes flanked by solid lines?
        through: turns.through.length &&
            _.findIndex(turns.through, lane => lane.change && !lane.change[0] && !lane.change[1]) !== -1,
        right: turnIsProtected("right")
    }, (protection, turn) => {
        if (!turns[turn].length) {
            return undefined;
        }
        // If the way only allows this turn and no others, then a lane change
        // restriction is irrelevant because it doesn't matter which lane the
        // driver is in.
        let leftmostLane = turns[turn][0];
        let rightmostLane = _.last(turns[turn]);
        if (leftmostLane.change === undefined && rightmostLane.change === undefined) {
            return undefined;
        }
        if (leftmostLane.change && leftmostLane.change[0] === undefined &&
            rightmostLane.change && rightmostLane.change[1] === undefined) {
            return undefined;
        }
        return protection;
    });
    
    // Form a line string representing the maneuver's turn lanes.
    let maneuverCoords = turf.getCoords(way.line).concat();
    if (progression < 0) {
        maneuverCoords.reverse();
    }
    let maneuverLine = turf.lineString(maneuverCoords);
    
    // Get the way's maximum speed limit, preferring the advisory speed limit
    // over the legal speed limit.
    let maxSpeed = getTagsForProgression("maxspeed:advisory", way, progression) ||
        getTagsForProgression("maxspeed", way, progression);
    
    // Return a single maneuver object for each turn type, except for unmarked
    // turns and for going straight through the intersection.
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

/**
 * Calculates an absolute bearing at the beginning or end of a line.
 *
 * @param line {LineString} A line representing a maneuver.
 * @param progression {Number} A positive number for the forward direction or a
 *  negative number for the backward direction.
 * @param fromEnd {Boolean} True to measure the bearing at the end of the line;
 *  false to measure from the beginning of the line.
 * @returns {Number} The absolute bearing of one end of the line.
 */
function getBearing(line, progression, fromEnd) {
    let length = turf.length(line, {
        units: "meters"
    });
    let startOffset = 0;
    let endOffset = Math.min(length, maxBearingDeltaRadius);
    if (fromEnd) {
        startOffset = length - endOffset;
        endOffset = startOffset + endOffset;
    }
    if (progression < 0) {
        [startOffset, endOffset] = [endOffset, startOffset];
    }
    return turf.bearing(turf.along(line, startOffset, {
        units: "meters"
    }), turf.along(line, endOffset, {
        units: "meters"
    }));
}

/**
 * Returns the value wrapped within the given range (as opposed to being clamped
 * to it).
 */
function wrap(value, min, max) {
    let range = max - min;
    let wrapped = ((value - min) % range + range) % range + min;
    return wrapped === min ? max : wrapped;
}

/**
 * Find the shorter angular distance between two bearings.
 */
function getBearingDelta(first, second) {
    let bearingDelta = second - first;
    return wrap(bearingDelta, -180, 180);
}

/**
 * Merges a maneuver with a connecting maneuver in chronological order.
 *
 * @param maneuver {Object} The maneuver to flatten. Its `next` property must be
 *  set to the connecting maneuver, and it must have `fromWays` and
 *  `progressions` properties.
 * @returns {Object} The same maneuver, flattened to incorporate the information
 *  previously set on the `next` property (which is removed).
 */
function flattenManeuver(maneuver) {
    let next = maneuver.next;
    if (!next) {
        return;
    }
    
    // Recurse down into the next maneuver in case there's a chain of maneuvers.
    flattenManeuver(next);
    
    console.assert(next.isConnection, "Next maneuver %o lacks isConnection property.", next.fromWay);
    
    // If a lane change restriction is lifted partway through a turn lane, it
    // may mean that this tool has too aggressively linked unrelated maneuvers,
    // or it may signal a tagging error.
    if (maneuver.protected && next.protected === false) {
        console.warn("Maneuver disallows lane changes at way %s but allows lane changes at way %s",
                     _.last(maneuver.fromWays), next.fromWays[0]);
    }
    
    // If a maneuver narrows to fewer lanes before the intersection, it may mean
    // that this tool has too aggressively linked unrelated maneuvers, or it may
    // signal a tagging error.
    if (maneuver.lanes > next.lanes) {
        console.warn("Maneuver drops %s lane(s) from %s to %s",
                     maneuver.lanes - next.lanes, _.last(maneuver.fromWays), next.fromWays[0]);
    }
    
    let length = turf.length(maneuver.line, {
        units: "meters"
    });
    let nextLength = turf.length(next.line, {
        units: "meters"
    });
    
    // Join the two maneuvers' geometries. The resulting maneuver traverses
    // multiple ways, not all of which necessarily point in the same direction.
    maneuver.fromWays = maneuver.fromWays.concat(next.fromWays);
    maneuver.progressions = maneuver.progressions.concat(next.progressions);
    maneuver.line = turf.lineString(turf.getCoords(maneuver.line).concat(turf.getCoords(next.line)));
    maneuver.viaNode = next.viaNode;
    
    // For a large intersection, the number of lanes for a turn may increase
    // going toward the intersection.
    maneuver.lanes = Math.max(maneuver.lanes, next.lanes);
    
    // Detect the beginning of a lane change restriction, if it begins partway
    // along the turn lane.
    if (!maneuver.protected && next.protected) {
        maneuver.protectionNode = next.fromNode;
    } else {
        maneuver.protectionNode = next.protectionNode;
    }
    
    // Calculate a average of the speed limits along the turn lane, weighted by
    // distance.
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
    
    // Index the data by IDs.
    let results = JSON.parse(data);
    let elts = results.elements;
    let ways = elts.filter(elt => elt.type === "way");
    waysById = _.fromPairs(ways.map(way => [way.id, way]));
    let nodes = elts.filter(elt => elt.type === "node");
    let nodesById = _.fromPairs(nodes.map(node => [node.id, node]));
    
    // Convert individual ways into turn maneuvers.
    let wayIdsByNodeId = {};
    let maneuvers = [];
    ways.forEach(way => {
        // Form a line string corresponding to the way.
        let nodes = way.nodes.map(id => nodesById[id]);
        let coords = nodes.map(node => [node.lon, node.lat]);
        way.line = turf.lineString(coords);
        
        // Index the way by the nodes it contains, making it easier to look up
        // connections.
        way.nodes.forEach(nodeId => {
            if (!(nodeId in wayIdsByNodeId)) {
                wayIdsByNodeId[nodeId] = [];
            }
            wayIdsByNodeId[nodeId].push(way.id);
        });
        
        way.progressions = {
            forward: way.tags.oneway !== "-1",
            backward: way.tags.oneway !== "yes"
        };
        
        // A one-lane, one-way service or link way is most likely a turn
        // channel, which would occur past the maneuver itself.
        if ((way.tags.turn || (way.tags.lanes === "1") || (!way.tags.lanes)) &&
            (!way.progressions.forward || !way.progressions.backward) &&
            (way.tags.highway === "service" || way.tags.highway.includes("_link"))) {
            return;
        }
        
        // Add one set of maneuvers for each direction of travel along the way.
        let wayManeuvers = [];
        if (way.progressions.forward) {
            let forwardManeuvers = getManeuversFromWay(way, 1);
            wayManeuvers = wayManeuvers.concat(forwardManeuvers);
        }
        if (way.progressions.backward) {
            let backwardManeuvers = getManeuversFromWay(way, -1);
            wayManeuvers = wayManeuvers.concat(backwardManeuvers);
        }
        if (wayManeuvers.length) {
            maneuvers = maneuvers.concat(wayManeuvers);
        }
    });
    
    // Link up maneuvers that traverse multiple ways.
    maneuvers.forEach(maneuver => {
        // Two maneuvers are connected if they...
        let connectedManeuvers = maneuvers.filter(otherManeuver =>
            // Share a node
            otherManeuver.fromNode === maneuver.viaNode &&
            // Are distinct ways (so not two sides of the same road)
            otherManeuver.fromWay !== maneuver.fromWay &&
            // Turn the same way (so not a left followed by a right)
            otherManeuver.turn === maneuver.turn
        );
        
        // Two maneuvers are not connected if...
        let way = waysById[maneuver.fromWay];
        _.remove(connectedManeuvers, connectedManeuver => {
            let connectedWay = waysById[connectedManeuver.fromWay];
            
            // One is on the main road and the other is on a ramp or turn
            // channel
            if ((way.tags.highway !== "service" && connectedWay.tags.highway === "service") ||
                (!way.tags.highway.includes("_link") && connectedWay.tags.highway.includes("_link"))) {
                return true;
            }
            
            // A lane change restriction ends after the first maneuver
            return maneuver.protected && connectedManeuver.protected === false;
        });
        
        // Calculate a turn angle between the maneuver and each of the connected
        // maneuvers.
        let bearing = getBearing(way.line, maneuver.progression, maneuver.progression > 0);
        let bearingDeltas = connectedManeuvers.map(connectedManeuver => {
            let connectedWay = waysById[connectedManeuver.fromWay];
            let connectedBearing = getBearing(connectedWay.line, connectedManeuver.progression,
                                              connectedManeuver.progression < 0);
            //console.log(maneuver.fromWay, bearing, connectedManeuver.fromWay, connectedBearing);
            return getBearingDelta(bearing, connectedBearing);
        });
        
        //bearingDeltas.forEach((delta, idx) => {
        //    if (Math.abs(delta) > 45) {
        //        let connectedManeuver = connectedManeuvers[idx];
        //        console.warn("Removing", maneuver.fromWay, bearing, connectedManeuver.fromWay, delta);
        //    }
        //});
        
        // Two maneuvers are not connected if they're over 45 degrees apart (in
        // which case the connected maneuver is probably on a cross street).
        // (Most connections are 30 degrees or less apart, but a bigger
        // difference may occur where a divided road begins at the
        // intersection.)
        _.remove(connectedManeuvers, (connectedManeuver, idx) => Math.abs(bearingDeltas[idx]) > 45);
        
        // The maneuver can only be merged with a single maneuver at the same
        // node. If multiple candidates remain, prefer one with the same road
        // classification.
        if (connectedManeuvers.length > 1) {
            let sameClassManeuvers = connectedManeuvers.filter(connectedManeuver => {
                let connectedWay = waysById[connectedManeuver.fromWay];
                return connectedWay.tags.highway === way.tags.highway;
            });
            if (sameClassManeuvers.length) {
                connectedManeuvers = sameClassManeuvers;
            }
        }
        
        // If still multiple candidates remain, prefer one with the same name.
        if (connectedManeuvers.length > 1) {
            let sameNamedManeuvers = connectedManeuvers.filter(connectedManeuver => {
                let connectedWay = waysById[connectedManeuver.fromWay];
                let connectedName = getTagsForProgression("name", connectedWay,
                                                          connectedManeuver.progression,
                                                          connectedManeuver.lanes);
                let name = getTagsForProgression("name", way, maneuver.progression, maneuver.lanes);
                return connectedName === name;
            });
            if (sameNamedManeuvers.length) {
                connectedManeuvers = sameNamedManeuvers;
            }
        }
        
        // If still multiple candidates remain, there may be a tagging error.
        console.assert(connectedManeuvers.length < 2,
                       "Ambiguous maneuver from %o via one of %o with bearing deltas %s",
                       maneuver, connectedManeuvers, bearingDeltas);
        
        // Link the maneuver to the only remaining connecting maneuver.
        if (connectedManeuvers.length) {
            maneuver.next = connectedManeuvers[0];
            connectedManeuvers[0].isConnection = true;
        }
    });
    
    // Prepare the maneuvers to be merged. From this point onward, a maneuver
    // is assumed to traverse multiple ways, not necessarily in the same
    // direction along all of them.
    maneuvers = maneuvers.map(maneuver => {
        maneuver.fromWays = [maneuver.fromWay];
        maneuver.progressions = [maneuver.progression];
        delete maneuver.fromWay;
        delete maneuver.progression;
        return maneuver;
    });
    
    // Flatten the maneuver array so that each item represents one maneuver
    // traversing as many ways as necessary.
    maneuvers = maneuvers.filter(maneuver => !maneuver.isConnection);
    maneuvers.forEach(flattenManeuver);
    
    // Find the cross street that each maneuver turns onto.
    maneuvers.forEach(maneuver => {
        let viaNodeId = maneuver.viaNode;
        let viaNode = nodesById[viaNodeId];
        let viaPoint = turf.point([viaNode.lon, viaNode.lat]);
        
        // Gather candidate cross streets based on intersecting nodes. Each
        // candidate must have at least one node beyond the intersection.
        let forwardCrossingWays = (wayIdsByNodeId[viaNodeId] || []).map(id => waysById[id])
            .filter(way => way.progressions.forward && way.nodes.indexOf(viaNodeId) !== way.nodes.length - 1);
        let backwardCrossingWays = (wayIdsByNodeId[viaNodeId] || []).map(id => waysById[id])
            .filter(way => way.progressions.backward && way.nodes.indexOf(viaNodeId) !== 0);
        
        // Calculate a turn angle between the maneuver and each of the candidate
        // crossing ways.
        let bearing = getBearing(maneuver.line, 1 /* maneuver.line was reversed in getManeuversFromWay() */, true);
        let forwardBearingDeltas = forwardCrossingWays.map(crossingWay => {
            // Form a line string corresponding to the way past the intersection.
            let endNode = nodesById[_.last(crossingWay.nodes)];
            let endPoint = turf.point([endNode.lon, endNode.lat]);
            let crossingLine = turf.lineSlice(viaPoint, endPoint, crossingWay.line);
            
            let crossingBearing = getBearing(crossingLine, 1, false);
            return getBearingDelta(bearing, crossingBearing);
        });
        let backwardBearingDeltas = backwardCrossingWays.map(crossingWay => {
            // Form a line string corresponding to the way up to the intersection.
            let startNode = nodesById[crossingWay.nodes[0]];
            let startPoint = turf.point([startNode.lon, startNode.lat]);
            let crossingLine = turf.lineSlice(startPoint, viaPoint, crossingWay.line);
            
            let crossingBearing = getBearing(crossingLine, -1, true);
            return getBearingDelta(bearing, crossingBearing);
        });
        
        // Gather together candidates that travel on the forward and backward
        // directions of the respective ways, along with their turn angles.
        let crossingWays = forwardCrossingWays.concat(backwardCrossingWays);
        let bearingDeltas = forwardBearingDeltas.concat(backwardBearingDeltas);
        console.assert(crossingWays.length == bearingDeltas.length);
        let crossingWaysWithDeltas = _.zip(crossingWays, bearingDeltas);
        
        // Find the candidate that has the most ideal (not slight, not sharp,
        // not backwards) turn angle.
        let crossingWay;
        switch (maneuver.turn) {
            case "reverse":
                // The ideal U-turn angle is 180 degrees. However, on a divided
                // road, a U-turn is effectively a left or right turn, depending
                // which side of the road the region drives on.
                crossingWay = _.maxBy(crossingWaysWithDeltas.filter(wayWithDelta => Math.abs(wayWithDelta[1]) > 30),
                                      wayWithDelta => Math.abs(wayWithDelta[1]));
                crossingWay = crossingWay && crossingWay[0];
                break;
            case "left":
                // The ideal left turn angle is around -90 degrees. Express the
                // turn angles relative to the ideal, the find the one that
                // deviates the least. Exclude any obvious U-turns.
                crossingWay = _.minBy(crossingWaysWithDeltas.filter(wayWithDelta => Math.abs(wayWithDelta[1]) < 150),
                                      wayWithDelta => Math.abs(wrap(wayWithDelta[1] + 90, -180, 180)));
                if (crossingWay && Math.abs(wrap(crossingWay[1] + 90, -180, 180)) > 90) {
                    console.log("Unusually sharp left turn from way %s onto %s at %s",
                                _.last(maneuver.fromWays), crossingWay[0].id, viaNodeId);
                }
                crossingWay = crossingWay && crossingWay[0];
                break;
            case "right":
                // The ideal right turn angle is around +90 degrees. Express the
                // turn angles relative to the ideal, the find the one that
                // deviates the least. Exclude any obvious U-turns.
                crossingWay = _.minBy(crossingWaysWithDeltas.filter(wayWithDelta => Math.abs(wayWithDelta[1]) < 150),
                                      wayWithDelta => Math.abs(wrap(wayWithDelta[1] - 90, -180, 180)));
                if (crossingWay && Math.abs(wrap(crossingWay[1] - 90, -180, 180)) > 90) {
                    console.log("Unusually sharp right turn from way %s onto %s at %s",
                                _.last(maneuver.fromWays), crossingWay[0].id, viaNodeId);
                }
                crossingWay = crossingWay && crossingWay[0];
                break;
        }
        
        if (crossingWay) {
            maneuver.toWay = crossingWay.id;
        } else {
            console.warn("Way %s has no road to turn %s onto at %s",
                         _.last(maneuver.fromWays), maneuver.turn, viaNodeId);
        }
    });
    
    // Output a tab-delimited representation of each maneuver.
    let writer = output && fs.createWriteStream(output);
    maneuvers.forEach(maneuver => {
        let lastWay = waysById[_.last(maneuver.fromWays)];
        let length = turf.length(maneuver.line, {
            units: "meters"
        });
        
        // If only part of the maneuver is subject to lane change restrictions,
        // determine the length of that part.
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
        
        let toWay = waysById[maneuver.toWay];
        let toClass = toWay && toWay.tags.highway;
        
        // Output to a file if specified or to standard output otherwise.
        let entry = `${maneuver.fromNode}\t${maneuver.viaNode}\t${maneuver.turn}\t${lastWay.tags.highway}\t${toClass || ""}\t${maneuver.lanes}\t${length}\t${protectedLength || ""}\t${maneuver.maxSpeed || ""}`;
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
