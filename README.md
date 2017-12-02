# apple-turnover

_Half-baked OpenStreetMap turn lane analysis_

Apple Turnover is a tool that performs basic analysis on the properties of turn lanes in OpenStreetMap.

## Installation and usage

1. Clone this repository and run `npm install` to install this tool’s dependencies.
1. Using [Overpass turbo](http://overpass-turbo.eu/), query for turn lanes in a specific region in which turn lanes have been mapped. Examples:
   * [Cincinnati, Ohio, United States](http://overpass-turbo.eu/s/tuq)
1. Click the Export button. Under the Data section, choose “raw data” and save the file to disk.
1. Run the following command to analyze the exported file and output the results:
   ```bash
   node index.js export.json output.csv
   ```
   If no output file is specified, the tool outputs to the command line.

## Output format

The output file is a tab-delimited file. Each line represents one maneuver, such as a left turn or right turn. Only explicitly tagged maneuvers (i.e., `turn:lanes:forward`) are accounted for. A maneuver multiple lanes wide is listed once. This tool accounts for way-splitting but not lane change restrictions. The file has the following columns:

* ID of the node at the beginning of the turn lane
* ID of the node at the end of the turn lane, where the driver turns
* `left`, `right`, or `reverse`, as indicated by lane markings or signage; combinations of maneuvers, such as `left;right`, result in separate maneuvers
* The `highway` tag of the way at the end of the turn lane (but not the way onto which the driver turns)
* The number of lanes that may be used for this maneuver
* The length of the turn lane in meters
* The explicit maximum speed limit along the turn lane in meters per second; if the speed limit varies along the turn lane, an average weighted by distance
