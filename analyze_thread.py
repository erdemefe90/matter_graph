import json

try:
    with open('nodes_dump.json', 'r') as f:
        data = json.load(f)

    print(f"{'NodeID':<8} {'Attr 0/53/4':<25} {'Attr 0/53/5':<20} {'Neighbors (ExtAddr)'}")
    print("-" * 100)

    for node in data:
        nid = node.get('node_id', '?')
        attrs = node.get('attributes', {})
        
        val4 = attrs.get('0/53/4', 'N/A')
        val5 = attrs.get('0/53/5', 'N/A')
        
        neighbors = []
        ntable = attrs.get('0/53/7')
        if isinstance(ntable, list):
            for entry in ntable[:3]: # first 3 neighbors
                neighbors.append(str(entry.get('0', '?')))
        
        print(f"{nid:<8} {str(val4):<25} {str(val5):<20} {', '.join(neighbors)}")

except Exception as e:
    print(e)
