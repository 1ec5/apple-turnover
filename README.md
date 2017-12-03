# Apple Turnover

[<img src="https://upload.wikimedia.org/wikipedia/commons/thumb/7/77/Pastry-Turnover-Apple.jpg/640px-Pastry-Turnover-Apple.jpg" width="320" alt="Half-baked OpenStreetMap turn lane analysis">](https://commons.wikimedia.org/wiki/File:Pastry-Turnover-Apple.jpg)

Apple Turnover is a tool that performs basic analysis on the attributes of [turn lanes](https://wiki.openstreetmap.org/wiki/Key:turn) in [OpenStreetMap](https://www.openstreetmap.org/).

## Features

With Apple Turnover, you can gather statistics about the lengths of turn lanes by speed limit, highway classification, or other attributes. Apple Turnover contains the following all-natural ingredients:

* Recognizes `:forward`, `:backward`, two-way, and one-way turn lane data
* Correctly handles left and right turn lanes on the same road in which the lanes’ start and end points are staggered
* Spans maneuvers across multiple ways split due to changes in lane count, speed limit, name, etc.
* Consolidates maneuvers that are multiple lanes wide

## How to bake

1. Clone this repository and run `npm install` to install this tool’s dependencies.
1. Using [Overpass turbo](http://overpass-turbo.eu/), query for turn lanes in a specific region in which turn lanes have been mapped. Examples:
   * [Greater Cincinnati and Northern Kentucky](http://overpass-turbo.eu/s/tvd)
   * [San Francisco Bay Area](http://overpass-turbo.eu/s/tuF)
   * [Santa Clara County, California](http://overpass-turbo.eu/s/tuD)
1. Click the Export button. Under the Data section, choose “raw data” and save the file to disk.
1. Run the following command to analyze the exported file and output the results:
   ```bash
   node index.js export.json output.csv
   ```
   If no output file is specified, the tool outputs to the command line.

## Output format

The output file is a tab-delimited file. Each line represents one maneuver, such as a left turn or right turn. Only explicitly tagged maneuvers (i.e., `turn:lanes:forward`) are accounted for. The file has the following columns:

* ID of the node at the beginning of the turn lane
* ID of the node at the end of the turn lane, where the driver turns
* `left`, `right`, or `reverse`, as indicated by lane markings or signage; combinations of maneuvers, such as `left;right`, result in separate maneuvers
* The `highway` tag of the way at the end of the turn lane (but not the way onto which the driver turns)
* The number of lanes that may be used for this maneuver
* The length of the turn lane in meters
* The explicit maximum speed limit along the turn lane in meters per second; if the speed limit varies along the turn lane, an average weighted by distance
